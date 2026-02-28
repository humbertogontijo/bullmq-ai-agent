import { Worker, FlowProducer, Queue } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';
import { initChatModel } from 'langchain/chat_models/universal';
import type { ConfigurableModel } from 'langchain/chat_models/universal';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ToolDefinition } from '@langchain/core/language_models/base';

import {
  buildAgentSystemMessage,
  buildOrchestratorSystemMessage,
  formatHistoryForOrchestrator,
} from './prompts.js';
import type {
  AgentGoal,
  AnyAgentTool,
  AgentWorkerOptions,
  AgentChildJobData,
  AgentChildResult,
  JobType,
  OrchestratorJobData,
  SerializedMessage,
  StepResult,
} from './types.js';
import {
  ORCHESTRATOR_QUEUE,
  AGENT_QUEUE,
  AGGREGATOR_QUEUE,
  getQueueName,
} from './types.js';
import {
  fetchSessionResults,
  findLatestResult,
  extractSingleGoalHistory,
  extractAgentMessages,
  deriveToolCalls,
  deriveRoutingHistory,
} from './history.js';

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
  private readonly llmConfig: AgentWorkerOptions['llm'];
  private readonly goals: Map<string, AgentGoal>;
  private readonly showConfirmation: boolean;
  private readonly multiGoalMode: boolean;
  private readonly queuePrefix: string;
  private readonly logger: AgentWorkerOptions['logger'];

  private orchestratorWorker!: Worker;
  private agentWorkerInstance!: Worker;
  private aggregatorWorker!: Worker;
  private flowProducer!: FlowProducer;
  private orchestratorQueue!: Queue;
  private aggregatorQueue!: Queue;

  constructor(options: AgentWorkerOptions) {
    this.connection = options.connection;
    this.llmConfig = options.llm;
    this.showConfirmation = options.showConfirmation ?? true;
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

  private async createLLM(tools?: ToolDefinition[]): Promise<ConfigurableModel> {
    const { model, modelProvider, apiKey, ...rest } = this.llmConfig;
    const llm = await initChatModel(model, {
      ...(modelProvider ? { modelProvider } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...rest,
    });
    return tools ? llm.bindTools(tools) : llm;
  }

  // -----------------------------------------------------------------------
  // Orchestrator worker
  // -----------------------------------------------------------------------

  private async processOrchestrator(
    job: Job<OrchestratorJobData>,
  ): Promise<StepResult> {
    const { sessionId, type, prompt } = job.data;

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

    if (!this.multiGoalMode) {
      const singleGoalId = prevState?.goalId ?? [...this.goals.keys()][0];
      return this.processSingleGoalStep(job, singleGoalId, type, prompt, prevState);
    }

    // Multi-goal mode
    if (type === 'prompt') {
      const prevHistory = prevState?.agentResults
        ? deriveRoutingHistory(prevState.agentResults)
        : prevState?.history ?? [];
      const agentIds = await this.routeToAgents(prompt ?? '', prevHistory);
      const routingJobId = await this.createAgentFlow(job, agentIds, prompt ?? '');
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
    const { sessionId, goalId, prompt, toolCalls, context } = job.data;
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { goalId, messages: [], status: 'complete' };
    }

    const model = await this.createLLM(toToolDefinitions(goal.tools));

    const messages: BaseMessage[] = [
      new SystemMessage(buildAgentSystemMessage(goal, this.multiGoalMode)),
    ];

    const aggResults = await fetchSessionResults(this.aggregatorQueue, sessionId);
    const agentHistory = extractAgentMessages(aggResults, goalId);
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
      messages.push(new HumanMessage(prompt));
    } else {
      return { goalId: goal.id, messages: [], status: 'complete' };
    }

    return this.runAgentLoop(goal, model, messages, restoredCount, context);
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
    maxRounds = 5,
  ): Promise<AgentChildResult> {
    let rounds = 0;

    while (rounds < maxRounds) {
      rounds++;
      const response = await model.invoke(messages);
      messages.push(response);

      if (!response.tool_calls?.length) {
        return {
          goalId: goal.id,
          messages: serializeMessages(messages.slice(restoredCount)),
          status: 'complete',
        };
      }

      if (this.showConfirmation) {
        return {
          goalId: goal.id,
          messages: serializeMessages(messages.slice(restoredCount)),
          status: 'awaiting-confirm',
        };
      }

      // Auto-execute tools
      for (const tc of response.tool_calls) {
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
    job: Job,
  ): Promise<StepResult> {
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

    const model = await this.createLLM(toToolDefinitions(goal.tools));
    const { sessionId, context } = job.data;

    const messages: BaseMessage[] = [
      new SystemMessage(buildAgentSystemMessage(goal, false)),
    ];

    const orchResults = await fetchSessionResults(this.orchestratorQueue, sessionId);
    const fullHistory = extractSingleGoalHistory(orchResults);
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
      messages.push(new HumanMessage(prompt));
    } else {
      return { history: [], goalId, status: 'active' };
    }

    const result = await this.runAgentLoop(goal, model, messages, restoredCount, context);
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
  ): Promise<string[]> {
    const goals = [...this.goals.values()];
    const model = await this.createLLM();

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
    const { sessionId, context } = orchestratorJob.data;
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
    const { sessionId, context } = orchestratorJob.data;
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
