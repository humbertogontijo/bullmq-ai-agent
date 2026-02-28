import type { ToolDefinition } from '@langchain/core/language_models/base';
import type { BaseMessage } from '@langchain/core/messages';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ConnectionOptions, Job } from 'bullmq';
import { FlowProducer, Queue, Worker } from 'bullmq';
import type { ConfigurableModel } from 'langchain/chat_models/universal';
import { initChatModel } from 'langchain/chat_models/universal';

import {
  deriveRoutingHistory,
  deriveToolCalls,
  extractAgentMessages,
  extractSingleGoalHistory,
  fetchSessionResults,
  findLatestResult,
} from './history.js';
import {
  buildAgentSystemMessage,
  buildOrchestratorSystemMessage,
  formatHistoryForOrchestrator,
} from './prompts.js';
import type {
  AgentChildJobData,
  AgentChildResult,
  AgentGoal,
  AgentWorkerLlmConfig,
  AgentWorkerLogger,
  AgentWorkerOptions,
  AnyAgentTool,
  JobProgress,
  JobType,
  OrchestratorJobData,
  SerializedMessage,
  StepResult,
} from './types.js';
import {
  AGENT_QUEUE,
  AGGREGATOR_QUEUE,
  getQueueName,
  ORCHESTRATOR_QUEUE,
} from './types.js';

// ---------------------------------------------------------------------------
// Message serialization helpers
// ---------------------------------------------------------------------------

function serializeMessages(msgs: BaseMessage[]): SerializedMessage[] {
  return msgs.map((m) => {
    if (m instanceof SystemMessage) {
      return { role: 'system' as const, content: m.content as string };
    }
    if (m instanceof HumanMessage) {
      return { role: 'human' as const, content: m.content as string };
    }
    if (m instanceof ToolMessage) {
      return {
        role: 'tool' as const,
        content: m.content as string,
        toolCallId: m.tool_call_id,
      };
    }
    // AIMessage
    const ai = m as AIMessage;
    const serialized: SerializedMessage = {
      role: 'ai' as const,
      content: (ai.content as string) ?? '',
    };
    if (ai.tool_calls?.length) {
      serialized.toolCalls = ai.tool_calls.map((tc) => ({
        id: tc.id ?? '',
        name: tc.name,
        args: tc.args as Record<string, unknown>,
      }));
    }
    return serialized;
  });
}

function deserializeMessages(msgs: SerializedMessage[]): BaseMessage[] {
  return msgs.map((m) => {
    switch (m.role) {
      case 'system':
        return new SystemMessage(m.content);
      case 'human':
        return new HumanMessage(m.content);
      case 'tool':
        return new ToolMessage({
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        });
      case 'ai': {
        const aiMsg = new AIMessage({
          content: m.content,
        });
        if (m.toolCalls?.length) {
          aiMsg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.args,
            type: 'tool_call' as const,
          }));
        }
        return aiMsg;
      }
    }
  });
}

const PENDING_TOOL_ERROR = JSON.stringify({
  error: 'Tool execution was not completed in a previous turn.',
});

/**
 * If the last message is an AI message with tool_calls and no following tool
 * messages, appends placeholder tool responses so the provider accepts the
 * history. Call this before appending a new user message when the user sent a
 * prompt without confirming pending tool calls.
 */
function ensureNoPendingToolCalls(messages: BaseMessage[]): void {
  const last = messages[messages.length - 1];
  if (!(last instanceof AIMessage) || !last.tool_calls?.length) return;
  for (const tc of last.tool_calls) {
    messages.push(
      new ToolMessage({
        content: PENDING_TOOL_ERROR,
        tool_call_id: tc.id ?? '',
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Convert user-defined AgentTool → ToolDefinition (OpenAI function-calling format).
// ---------------------------------------------------------------------------

function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: JSON.parse(JSON.stringify(t.schema)),
    },
  }));
}

// ---------------------------------------------------------------------------
// AgentWorker
// ---------------------------------------------------------------------------

export class AgentWorker {
  private readonly connection: ConnectionOptions;
  private readonly llmConfig: AgentWorkerLlmConfig;
  private readonly goals: Map<string, AgentGoal>;
  private readonly multiGoalMode: boolean;
  private readonly queuePrefix: string;
  private readonly logger?: AgentWorkerLogger;

  private orchestratorWorker!: Worker;
  private agentWorkerInstance!: Worker;
  private aggregatorWorker!: Worker;
  private flowProducer!: FlowProducer;
  private orchestratorQueue!: Queue;
  private aggregatorQueue!: Queue;

  constructor(options: AgentWorkerOptions) {
    this.connection = options.connection;
    if (options.llmConfig == null || typeof options.llmConfig !== 'function') {
      throw new Error(
        'AgentWorker requires llmConfig: a function (options) => Promise<{ model: string; ... }>. ' +
        'It is used to supply LLM settings for each step (e.g. model, apiKey).',
      );
    }
    this.llmConfig = options.llmConfig;
    this.goals = new Map(options.goals.map((g) => [g.id, g]));
    this.multiGoalMode = options.goals.length > 1;
    this.queuePrefix = options.queuePrefix ?? '';
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    const orchQueue = getQueueName(this.queuePrefix, ORCHESTRATOR_QUEUE);
    const agentQueue = getQueueName(this.queuePrefix, AGENT_QUEUE);
    const aggQueue = getQueueName(this.queuePrefix, AGGREGATOR_QUEUE);

    this.flowProducer = new FlowProducer({ connection: this.connection });
    this.orchestratorQueue = new Queue(orchQueue, {
      connection: this.connection,
    });
    this.aggregatorQueue = new Queue(aggQueue, {
      connection: this.connection,
    });

    const withErrorLog =
      <T, R>(workerName: string, fn: (job: Job<T>) => Promise<R>) =>
        async (job: Job<T>): Promise<R> => {
          try {
            return await fn(job);
          } catch (err) {
            const msg = `[${workerName}] Job ${job.id} failed: ${err instanceof Error ? err.stack : err}`;
            this.logger?.error(msg, err instanceof Error ? err : undefined);
            throw err;
          }
        };

    this.orchestratorWorker = new Worker<OrchestratorJobData>(
      orchQueue,
      withErrorLog('orchestrator', (job) => this.processOrchestrator(job)),
      { connection: this.connection },
    );

    this.agentWorkerInstance = new Worker<AgentChildJobData>(
      agentQueue,
      withErrorLog('agent', (job) => this.processAgent(job)),
      { connection: this.connection },
    );

    this.aggregatorWorker = new Worker(
      aggQueue,
      withErrorLog('aggregator', (job) => this.processAggregator(job)),
      { connection: this.connection },
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.orchestratorWorker?.close(),
      this.agentWorkerInstance?.close(),
      this.aggregatorWorker?.close(),
      this.flowProducer?.close(),
      this.orchestratorQueue?.close(),
      this.aggregatorQueue?.close(),
    ]);
  }

  // -----------------------------------------------------------------------
  // LLM construction
  // -----------------------------------------------------------------------

  private async createLLM(
    tools?: ToolDefinition[],
    jobContext?: { goalId?: string; context?: Record<string, unknown> },
  ): Promise<ConfigurableModel> {
    const config = await this.llmConfig({
      goalId: jobContext?.goalId,
      context: jobContext?.context,
    });

    let llm: ConfigurableModel;
    try {
      const { model, modelProvider, apiKey, ...rest } = config;
      llm = await initChatModel(model, {
        ...(modelProvider ? { modelProvider } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...rest,
      });
    } catch (err) {
      throw new Error(
        `Failed to create model for config "${JSON.stringify(config)}": ${err}`,
      );
    }
    return tools ? llm.bindTools(tools) : llm;
  }

  // -----------------------------------------------------------------------
  // Orchestrator worker
  // -----------------------------------------------------------------------

  private async processOrchestrator(
    job: Job<OrchestratorJobData>,
  ): Promise<StepResult> {
    const { sessionId, type, prompt } = job.data;

    await job.updateProgress({
      phase: 'prompt-read',
      sessionId,
    });

    const prevState = await findLatestResult(
      this.orchestratorQueue,
      this.aggregatorQueue,
      sessionId,
    );

    if (type === 'end-chat') {
      return {
        history: [],
        goalId: prevState?.goalId,
        status: 'ended',
      };
    }

    // Single-goal mode, or explicit goalId (run as single-goal so history stays in orchestrator)
    if (!this.multiGoalMode || job.data.goalId) {
      const singleGoalId =
        job.data.goalId ?? prevState?.goalId ?? [...this.goals.keys()][0];
      return this.processSingleGoalStep(job, singleGoalId, type, prompt, prevState);
    }

    // Multi-goal mode (routing, no explicit goalId)
    if (type === 'prompt') {
      await job.updateProgress({ phase: 'routing', sessionId });
      const agentIds = await this.routeToAgents(
        prompt ?? '',
        prevState?.agentResults
          ? deriveRoutingHistory(prevState.agentResults)
          : prevState?.history ?? [],
        job.data.context,
      );
      const routingJobId = await this.createAgentFlow(
        job,
        agentIds,
        prompt ?? '',
      );
      return {
        history: prompt ? [{ role: 'human' as const, content: prompt }] : [],
        status: 'routing',
        routingJobId,
      };
    }

    if (type === 'confirm') {
      const prevAgentResults = prevState?.agentResults;
      if (!prevAgentResults) {
        return { history: [], status: 'active' };
      }
      const awaitingAgents = Object.entries(prevAgentResults).filter(
        ([, r]) => r.status === 'awaiting-confirm',
      );
      if (awaitingAgents.length === 0) {
        return { history: [], status: 'active' };
      }
      const routingJobId = await this.createConfirmFlow(job, awaitingAgents);
      return { history: [], status: 'routing', routingJobId };
    }

    return { history: [], status: 'active' };
  }

  // -----------------------------------------------------------------------
  // Agent worker (per-goal child)
  // -----------------------------------------------------------------------

  private async processAgent(
    job: Job<AgentChildJobData>,
  ): Promise<AgentChildResult> {
    const { sessionId, goalId, prompt, toolCalls, context, initialMessages, toolChoice, autoExecuteTools } =
      job.data;
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { goalId, messages: [], status: 'complete' };
    }

    const model = await this.createLLM(toToolDefinitions(goal.tools), {
      goalId,
      context,
    });

    const messages: BaseMessage[] = [
      new SystemMessage(buildAgentSystemMessage(goal, this.multiGoalMode)),
    ];

    if (initialMessages?.length) {
      messages.push(...deserializeMessages(initialMessages));
    }

    // Merge both queues so switching single/multi-goal does not lose history
    const [orchResults, aggResults] = await Promise.all([
      fetchSessionResults(this.orchestratorQueue, sessionId),
      fetchSessionResults(this.aggregatorQueue, sessionId),
    ]);
    const agentHistory = [
      ...extractSingleGoalHistory(orchResults),
      ...extractAgentMessages(aggResults, goalId),
    ];
    if (agentHistory.length) {
      messages.push(...deserializeMessages(agentHistory));
    }

    const restoredCount = messages.length;

    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        const handler = goal.tools.find((t) => t.name === tc.name);
        if (!handler) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
              tool_call_id: tc.id,
            }),
          );
          continue;
        }
        try {
          const result = await handler.handler(tc.args, context);
          messages.push(
            new ToolMessage({
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            }),
          );
        } catch (err) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
              tool_call_id: tc.id,
            }),
          );
        }
      }
    } else if (prompt) {
      ensureNoPendingToolCalls(messages);
      messages.push(new HumanMessage(prompt));
    } else {
      return { goalId: goal.id, messages: [], status: 'complete' };
    }

    const onProgress = (progress: JobProgress) =>
      job.updateProgress({ ...progress, sessionId, goalId });

    return this.runAgentLoop(
      goal,
      model,
      messages,
      restoredCount,
      context,
      toolChoice,
      autoExecuteTools === true,
      onProgress,
    );
  }

  /**
   * Run the LLM -> tool-call -> execute loop for an agent.
   * Returns only `goalId`, `messages` (delta), and `status`.
   * All other fields (response, toolCalls) are derived from messages
   * by callers when needed.
   */
  private async runAgentLoop(
    goal: AgentGoal,
    model: ConfigurableModel,
    messages: BaseMessage[],
    restoredCount: number,
    context?: Record<string, unknown>,
    toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none',
    autoExecuteTools = false,
    onProgress?: (progress: JobProgress) => void,
    maxRounds = 5,
  ): Promise<AgentChildResult> {
    let rounds = 0;
    const invokeOptions = toolChoice !== undefined ? { tool_choice: toolChoice } : undefined;

    while (rounds < maxRounds) {
      rounds++;
      onProgress?.({ phase: 'thinking' });
      const response = await model.invoke(messages, invokeOptions);
      messages.push(response);

      if (!response.tool_calls?.length) {
        onProgress?.({ phase: 'typing' });
        return {
          goalId: goal.id,
          messages: serializeMessages(messages.slice(restoredCount)),
          status: 'complete',
        };
      }

      if (!autoExecuteTools) {
        return {
          goalId: goal.id,
          messages: serializeMessages(messages.slice(restoredCount)),
          status: 'awaiting-confirm',
        };
      }

      // Auto-execute tools
      for (const tc of response.tool_calls) {
        onProgress?.({ phase: 'executing-tool', toolName: tc.name });
        const handler = goal.tools.find((t) => t.name === tc.name);
        if (!handler) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
              tool_call_id: tc.id ?? '',
            }),
          );
          continue;
        }
        try {
          const result = await handler.handler(tc.args as Record<string, unknown>, context);
          messages.push(
            new ToolMessage({
              content: JSON.stringify(result),
              tool_call_id: tc.id ?? '',
            }),
          );
        } catch (err) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
              tool_call_id: tc.id ?? '',
            }),
          );
        }
      }
    }

    return {
      goalId: goal.id,
      messages: serializeMessages(messages.slice(restoredCount)),
      status: 'complete',
    };
  }

  // -----------------------------------------------------------------------
  // Aggregator worker (parent of agent children)
  // -----------------------------------------------------------------------

  private async processAggregator(
    job: Job<{ sessionId: string }>,
  ): Promise<StepResult> {
    await job.updateProgress({
      phase: 'aggregating',
      sessionId: job.data.sessionId,
    });
    const childValues = await job.getChildrenValues<AgentChildResult>();
    const agentResults: Record<string, AgentChildResult> = {};

    for (const result of Object.values(childValues)) {
      if (result?.goalId) {
        agentResults[result.goalId] = result;
      }
    }

    const anyAwaiting = Object.values(agentResults).some(
      (r) => r.status === 'awaiting-confirm',
    );

    return {
      history: [],
      agentResults,
      status: anyAwaiting ? 'awaiting-confirm' : 'active',
    };
  }

  // -----------------------------------------------------------------------
  // Single-goal mode
  // -----------------------------------------------------------------------

  private async processSingleGoalStep(
    job: Job<OrchestratorJobData>,
    goalId: string,
    type: JobType,
    prompt: string | undefined,
    prevState: StepResult | null,
  ): Promise<StepResult> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { history: [], goalId, status: 'active' };
    }

    const { sessionId, context, initialMessages, toolChoice, autoExecuteTools } = job.data;
    const model = await this.createLLM(toToolDefinitions(goal.tools), {
      goalId,
      context,
    });

    const messages: BaseMessage[] = [
      new SystemMessage(buildAgentSystemMessage(goal, false)),
    ];

    if (initialMessages?.length) {
      messages.push(...deserializeMessages(initialMessages));
    }

    // Merge both queues so switching single/multi-goal does not lose history
    const [orchResults, aggResults] = await Promise.all([
      fetchSessionResults(this.orchestratorQueue, sessionId),
      fetchSessionResults(this.aggregatorQueue, sessionId),
    ]);
    const fullHistory = [
      ...extractSingleGoalHistory(orchResults),
      ...extractAgentMessages(aggResults, goalId),
    ];
    if (fullHistory.length) {
      messages.push(...deserializeMessages(fullHistory));
    }

    const restoredCount = messages.length;

    if (type === 'confirm' && prevState?.toolCalls) {
      for (const tc of prevState.toolCalls) {
        const handler = goal.tools.find((t) => t.name === tc.name);
        if (!handler) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
              tool_call_id: tc.id,
            }),
          );
          continue;
        }
        try {
          const result = await handler.handler(tc.args, context);
          messages.push(
            new ToolMessage({
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            }),
          );
        } catch (err) {
          messages.push(
            new ToolMessage({
              content: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
              tool_call_id: tc.id,
            }),
          );
        }
      }
    } else if (prompt) {
      ensureNoPendingToolCalls(messages);
      messages.push(new HumanMessage(prompt));
    } else {
      return { history: [], goalId, status: 'active' };
    }

    const onProgress = (progress: JobProgress) =>
      job.updateProgress({ ...progress, sessionId: job.data.sessionId, goalId });

    const result = await this.runAgentLoop(
      goal,
      model,
      messages,
      restoredCount,
      context,
      toolChoice,
      autoExecuteTools === true,
      onProgress,
    );
    const isAwaiting = result.status === 'awaiting-confirm';

    return {
      history: result.messages,
      goalId,
      toolCalls: isAwaiting
        ? deriveToolCalls(result.messages, goalId)
        : undefined,
      status: isAwaiting ? 'awaiting-confirm' : 'active',
    };
  }

  // -----------------------------------------------------------------------
  // Multi-goal helpers
  // -----------------------------------------------------------------------

  private async routeToAgents(
    prompt: string,
    history: SerializedMessage[],
    context?: Record<string, unknown>,
  ): Promise<string[]> {
    const goals = [...this.goals.values()];
    const model = await this.createLLM(undefined, { context });

    const systemMsg = buildOrchestratorSystemMessage(goals);
    const historyContext = formatHistoryForOrchestrator(history);
    const userContent = historyContext
      ? `${historyContext}\n\nUser: ${prompt}`
      : prompt;

    try {
      const response = await model.invoke([
        new SystemMessage(systemMsg),
        new HumanMessage(userContent),
      ]);

      const content = (response.content as string).trim();
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) {
        return goals.map((g) => g.id);
      }

      const parsed = JSON.parse(match[0]) as string[];
      const validIds = parsed.filter((id) => this.goals.has(id));
      return validIds.length > 0 ? validIds : goals.map((g) => g.id);
    } catch {
      return goals.map((g) => g.id);
    }
  }

  private async createAgentFlow(
    orchestratorJob: Job<OrchestratorJobData>,
    agentIds: string[],
    prompt: string,
  ): Promise<string> {
    const { sessionId, context, initialMessages, toolChoice, autoExecuteTools } = orchestratorJob.data;
    const ts = Date.now();
    const aggregatorJobId = `${sessionId}/${ts}`;
    const { removeOnComplete, removeOnFail } = orchestratorJob.opts;
    const aggQueue = getQueueName(this.queuePrefix, AGGREGATOR_QUEUE);
    const agentQueue = getQueueName(this.queuePrefix, AGENT_QUEUE);

    await this.flowProducer.add({
      name: 'aggregator',
      queueName: aggQueue,
      data: { sessionId },
      opts: {
        jobId: aggregatorJobId,
        removeOnComplete,
        removeOnFail,
      },
      children: agentIds.map((goalId) => ({
        name: `agent-${goalId}`,
        queueName: agentQueue,
        data: {
          sessionId,
          goalId,
          prompt,
          ...(context !== undefined && { context }),
          ...(initialMessages !== undefined && { initialMessages }),
          ...(toolChoice !== undefined && { toolChoice }),
          ...(autoExecuteTools !== undefined && { autoExecuteTools }),
        } satisfies AgentChildJobData,
        opts: {
          jobId: `${sessionId}/${ts}/${goalId}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    });

    return aggregatorJobId;
  }

  private async createConfirmFlow(
    orchestratorJob: Job<OrchestratorJobData>,
    awaitingAgents: [string, AgentChildResult][],
  ): Promise<string> {
    const { sessionId, context, initialMessages } = orchestratorJob.data;
    const ts = Date.now();
    const aggregatorJobId = `${sessionId}/${ts}`;
    const { removeOnComplete, removeOnFail } = orchestratorJob.opts;
    const aggQueue = getQueueName(this.queuePrefix, AGGREGATOR_QUEUE);
    const agentQueue = getQueueName(this.queuePrefix, AGENT_QUEUE);

    await this.flowProducer.add({
      name: 'aggregator',
      queueName: aggQueue,
      data: { sessionId },
      opts: {
        jobId: aggregatorJobId,
        removeOnComplete,
        removeOnFail,
      },
      children: awaitingAgents.map(([goalId, result]) => ({
        name: `agent-${goalId}`,
        queueName: agentQueue,
        data: {
          sessionId,
          goalId,
          toolCalls: deriveToolCalls(result.messages, goalId),
          ...(context !== undefined && { context }),
          ...(initialMessages !== undefined && { initialMessages }),
        } satisfies AgentChildJobData,
        opts: {
          jobId: `${sessionId}/${ts}/${goalId}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    });

    return aggregatorJobId;
  }
}
