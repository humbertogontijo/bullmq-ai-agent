import type { ToolDefinition } from '@langchain/core/language_models/base';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
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
  DEFAULT_REJECTION,
  formatHistoryForOrchestrator,
  HUMAN_INPUT_TIP_PREFIX,
} from './prompts.js';
import { inferMetadataSchema } from '@langchain/redis';
import { loadDocumentsFromSource } from './rag/loadDocument.js';
import { createRetrieveTool } from './rag/retrieveTool.js';
import { splitDocuments } from './rag/splitDocuments.js';
import { createRedisClient, getVectorStore } from './rag/vectorStore.js';
import type { RedisLike } from './sessionConfig.js';
import { getSessionConfig, type SessionConfig } from './sessionConfig.js';
import type {
  ActionRequest,
  AgentChildJobData,
  AgentGoal,
  AgentTool,
  AgentWorkerLlmConfig,
  AgentWorkerLogger,
  AgentWorkerOptions,
  DocumentJobData,
  DocumentSource,
  EmbeddingConfig,
  JobProgress,
  JobType,
  OrchestratorJobData,
  PromptAttachment,
  ResumeCommand,
  SerializedMessage,
  StepResult,
  ToolApprovalDetail,
} from './types.js';
import {
  AGENT_QUEUE,
  AGGREGATOR_QUEUE,
  DOCUMENT_QUEUE,
  getQueueName,
  HUMAN_IN_THE_LOOP_TOOL_NAME,
  HUMAN_INPUT_TOOL_DEFINITION,
  ORCHESTRATOR_QUEUE,
} from './types.js';
import { getJobNameFromGoalId } from './utils.js';

// ---------------------------------------------------------------------------
// Message serialization helpers
// ---------------------------------------------------------------------------

function serializeMessages(msgs: BaseMessage[]): SerializedMessage[] {
  return msgs.map((m) => {
    if (m instanceof SystemMessage) {
      return { role: 'system' as const, content: m.content as string };
    }
    if (m instanceof HumanMessage) {
      const content = m.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const attachments: PromptAttachment[] = [];
        for (const block of content) {
          if (typeof block !== 'object' || block === null || !('type' in block)) continue;
          if (block.type === 'text' && 'text' in block) {
            textParts.push(String(block.text));
          } else if (
            (block.type === 'image' || block.type === 'video' || block.type === 'audio' || block.type === 'file') &&
            ('url' in block || 'data' in block || 'fileId' in block)
          ) {
            const b = block as Record<string, unknown>;
            attachments.push({
              type: block.type,
              ...(b.mimeType != null && { mimeType: b.mimeType as string }),
              ...(b.metadata != null && { metadata: b.metadata as Record<string, unknown> }),
              ...(b.url != null && { url: b.url as string }),
              ...(b.data != null && { data: b.data as string }),
              ...(b.fileId != null && { fileId: b.fileId as string }),
              ...(block.type === 'image' && b.detail != null && { detail: b.detail as 'auto' | 'low' | 'high' }),
            });
          }
        }
        const out: SerializedMessage = {
          role: 'human' as const,
          content: textParts.join('\n\n') || '',
        };
        if (attachments.length) out.attachments = attachments;
        return out;
      }
      return { role: 'human' as const, content: content as string };
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
      case 'human': {
        if (m.attachments?.length) {
          const content: MessageContent = [
            { type: 'text', text: m.content },
            ...m.attachments,
          ] as MessageContent;
          return new HumanMessage(content);
        }
        return new HumanMessage(m.content);
      }
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

/**
 * If the last message is an AI message with unanswered tool_calls, remove it.
 * This prevents provider errors when appending a new user message after the
 * user sent a prompt without addressing pending tool calls.
 */
function stripTrailingToolCalls(messages: BaseMessage[]): void {
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (!(last instanceof AIMessage) || !last.tool_calls?.length) return;
    messages.pop();
  }
}

function toToolDefinitions(tools: AgentTool[], includeHumanInput = false): ToolDefinition[] {
  const defs: ToolDefinition[] = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: JSON.parse(JSON.stringify(t.schema)),
    },
  }));
  if (includeHumanInput) {
    defs.push(HUMAN_INPUT_TOOL_DEFINITION);
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Resume helpers (work with the discriminated ResumeCommand union)
// ---------------------------------------------------------------------------

function isToolApproved(
  toolName: string,
  command: ResumeCommand & { type: 'tool_approval' },
): boolean {
  const { approved } = command.payload;
  const entry = approved[toolName];
  if (entry === undefined || entry === false) return false;
  if (entry === true) return true;
  return (entry as ToolApprovalDetail).approved;
}

function getRejectionFeedback(
  toolName: string,
  command: ResumeCommand & { type: 'tool_approval' },
): string {
  const { approved } = command.payload;
  const entry = approved[toolName];
  if (entry != null && typeof entry === 'object' && typeof (entry as ToolApprovalDetail).feedback === 'string') {
    return (entry as ToolApprovalDetail).feedback!;
  }
  return DEFAULT_REJECTION;
}

// ---------------------------------------------------------------------------
// Shared tool execution
// ---------------------------------------------------------------------------

async function executeToolHandler(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  tools: AgentTool[],
  context?: Record<string, unknown>,
): Promise<ToolMessage> {
  const handler = tools.find((t) => t.name === toolName);
  if (!handler) {
    return new ToolMessage({
      content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      tool_call_id: toolCallId,
    });
  }
  try {
    const result = await handler.handler(args, context);
    return new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: toolCallId,
    });
  } catch (err) {
    return new ToolMessage({
      content: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      tool_call_id: toolCallId,
    });
  }
}

function rejectToolCall(toolCallId: string, feedback: string): ToolMessage {
  return new ToolMessage({
    content: JSON.stringify({ error: feedback }),
    tool_call_id: toolCallId,
  });
}

async function processToolApproval(
  command: ResumeCommand & { type: 'tool_approval' },
  actions: Array<{ name: string; id: string; arguments: Record<string, unknown> }>,
  tools: AgentTool[],
  context?: Record<string, unknown>,
): Promise<ToolMessage[]> {
  const results: ToolMessage[] = [];
  for (const action of actions) {
    if (isToolApproved(action.name, command)) {
      results.push(await executeToolHandler(action.name, action.id, action.arguments, tools, context));
    } else {
      results.push(rejectToolCall(action.id, getRejectionFeedback(action.name, command)));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Shared goal step input
// ---------------------------------------------------------------------------

/** Build content for HumanMessage: string or [text, ...attachments] for multimodal. */
function buildHumanContent(
  prompt: string,
  attachments?: PromptAttachment[],
): MessageContent {
  if (!attachments?.length) return prompt;
  return [
    { type: 'text' as const, text: prompt },
    ...attachments,
  ] as MessageContent;
}

interface GoalStepInput {
  goal: AgentGoal;
  agentId?: string;
  /** When agent has RAG, the vector store to pass to the retrieve tool via context. */
  ragVectorStore?: Awaited<ReturnType<typeof getVectorStore>>;
  sessionId: string;
  context?: Record<string, unknown>;
  initialMessages?: SerializedMessage[];
  prompt?: string;
  attachments?: PromptAttachment[];
  command?: ResumeCommand;
  /** Pre-extracted action requests from the previous interrupt (for tool_approval). */
  actionRequests?: ActionRequest[];
  /** Tool call ID for the human_in_the_loop action (for hitl_response/hitl_direct_reply). */
  humanInputToolCallId?: string;
  /** Pending messages to restore before the ToolMessage (for hitl_response). */
  pendingMessages?: SerializedMessage[];
  toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none';
  autoExecuteTools?: boolean;
  humanInTheLoop?: boolean;
  onProgress?: (progress: JobProgress) => void;
}

// ---------------------------------------------------------------------------
// AgentWorker
// ---------------------------------------------------------------------------

/** Cached RAG vector store and redis client to close on worker close. */
interface RAGCacheEntry {
  store: Awaited<ReturnType<typeof getVectorStore>>;
  createdClient?: Awaited<ReturnType<typeof createRedisClient>>;
}

export class AgentWorker {
  private readonly connection: ConnectionOptions;
  private readonly llmConfig: AgentWorkerLlmConfig;
  private readonly goals: Map<string, AgentGoal>;
  private readonly multiGoalMode: boolean;
  private readonly queuePrefix: string;
  private readonly logger?: AgentWorkerLogger;
  private readonly rag?: AgentWorkerOptions['rag'];
  private readonly ragCache = new Map<string, RAGCacheEntry>();

  private orchestratorWorker!: Worker;
  private agentWorkerInstance!: Worker;
  private aggregatorWorker!: Worker;
  private documentWorker?: Worker<DocumentJobData>;
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
    this.rag = options.rag;
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

    if (this.rag) {
      const docQueue = getQueueName(this.queuePrefix, DOCUMENT_QUEUE);
      this.documentWorker = new Worker<DocumentJobData>(
        docQueue,
        withErrorLog('document', (job) => this.processDocumentJob(job)),
        { connection: this.connection },
      );
    }
  }

  private async processDocumentJob(job: Job<DocumentJobData>): Promise<void> {
    const { agentId, source } = job.data;
    if (!this.rag) {
      throw new Error('Document job requires AgentWorkerOptions.rag (RAG-enabled worker).');
    }
    await this.ingestDocuments(
      agentId,
      source,
      this.rag.embedding
    );
  }

  /** Load, split, embed, and store documents. Uses a dedicated redis client that is closed after use. */
  private async ingestDocuments(
    agentId: string,
    source: DocumentSource,
    embedding: EmbeddingConfig,
  ): Promise<void> {
    const documents = await loadDocumentsFromSource(source);
    const splits = await splitDocuments(documents);
    const redisClient = await createRedisClient(this.connection);
    try {
      const store = await getVectorStore({
        redisClient,
        queuePrefix: this.queuePrefix,
        agentId,
        embedding,
      });
      await store.addDocuments(splits);
    } finally {
      await redisClient.quit();
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.ragCache.values()]
        .map((e) => e.createdClient?.quit())
        .filter(Boolean),
    );
    this.ragCache.clear();
    await Promise.all([
      this.orchestratorWorker?.close(),
      this.agentWorkerInstance?.close(),
      this.aggregatorWorker?.close(),
      this.documentWorker?.close(),
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
    const { sessionId, agentId, type, prompt } = job.data;

    await job.updateProgress({
      phase: 'prompt-read',
      sessionId,
    });

    const redis = (await this.orchestratorQueue.client) as RedisLike;
    const fromRedis = await getSessionConfig(redis, this.queuePrefix, sessionId);
    const requestOverride = job.data.sessionConfig;
    const sessionConfig: Required<SessionConfig> = requestOverride
      ? {
        autoExecuteTools: requestOverride.autoExecuteTools ?? fromRedis.autoExecuteTools,
        humanInTheLoop: requestOverride.humanInTheLoop ?? fromRedis.humanInTheLoop,
      }
      : fromRedis;

    const prevState = await findLatestResult(
      this.orchestratorQueue,
      this.aggregatorQueue,
      sessionId,
    );

    if (type === 'end-chat') {
      return {
        history: [],
        agentId,
        goalId: prevState?.goalId,
        status: 'ended',
      };
    }

    if (type === 'command') {
      const command = job.data.command;
      if (!command) return { history: [], agentId, goalId: prevState?.goalId, status: 'active' };

      // Single-goal: process resume in single-goal step
      if (!this.multiGoalMode || job.data.goalId) {
        const singleGoalId = job.data.goalId ?? prevState?.goalId;
        if (!singleGoalId || !this.goals.has(singleGoalId)) {
          return {
            history: [{ role: 'ai', content: "Couldn't find a goal for that request." }],
            agentId,
            status: 'active',
          };
        }
        return this.processSingleGoalStep(job, singleGoalId, type, prompt, prevState, sessionConfig);
      }

      // Multi-goal: tool_approval for interrupted agents
      if (
        command.type === 'tool_approval' &&
        prevState?.status === 'interrupted' &&
        prevState?.childrenValues
      ) {
        const awaitingAgents = Object.entries(prevState.childrenValues).filter(
          ([, r]) => r.status === 'interrupted',
        );
        if (awaitingAgents.length > 0) {
          const routingJobId = await this.createConfirmFlow(job, agentId, awaitingAgents, sessionConfig);
          return { history: [], agentId, status: 'routing', routingJobId };
        }
      }

      // Multi-goal: hitl_response or hitl_direct_reply
      if (
        (command.type === 'hitl_response' || command.type === 'hitl_direct_reply') &&
        prevState?.status === 'interrupted'
      ) {
        const humanInterrupt = prevState.interrupts?.find((i) => i.type === 'human_input');
        const humanAction = humanInterrupt?.actionRequests.find(
          (a) => a.name === HUMAN_IN_THE_LOOP_TOOL_NAME,
        );
        if (humanInterrupt?.goalId && humanAction) {
          const routingJobId = await this.createHumanInputResponseFlow(
            job,
            agentId,
            humanInterrupt.goalId,
            humanAction.id,
            command,
            humanInterrupt.pendingMessages,
            sessionConfig,
          );
          return { history: [], agentId, status: 'routing', routingJobId };
        }
      }

      return { history: [], agentId, goalId: prevState?.goalId, status: 'active' };
    }

    // Single-goal mode, or explicit goalId
    if (!this.multiGoalMode || job.data.goalId) {
      const singleGoalId = job.data.goalId ?? prevState?.goalId;
      if (!singleGoalId || !this.goals.has(singleGoalId)) {
        return {
          history: [{ role: 'ai', content: "Couldn't find a goal for that request." }],
          agentId,
          status: 'active',
        };
      }
      return this.processSingleGoalStep(job, singleGoalId, type, prompt, prevState, sessionConfig);
    }

    // Multi-goal mode (routing)
    if (type === 'prompt') {
      await job.updateProgress({ phase: 'routing', sessionId });
      const promptText = job.data.prompt ?? '';
      const goalIds = await this.routeToGoals(
        promptText,
        prevState?.childrenValues
          ? deriveRoutingHistory(prevState.childrenValues)
          : prevState?.history ?? [],
        job.data.context,
      );
      const routingJobId = await this.createAgentFlow(
        job,
        agentId,
        goalIds,
        promptText,
        sessionConfig,
      );
      const hasContent = promptText || job.data.attachments?.length;
      const historyEntry: SerializedMessage | undefined = hasContent
        ? {
          role: 'human' as const,
          content: promptText,
          ...(job.data.attachments?.length && { attachments: job.data.attachments }),
        }
        : undefined;
      return {
        history: historyEntry ? [historyEntry] : [],
        agentId,
        status: 'routing',
        routingJobId,
      };
    }

    return { history: [], agentId, status: 'active' };
  }

  // -----------------------------------------------------------------------
  // Agent worker (per-goal child in multi-goal mode)
  // -----------------------------------------------------------------------

  private async processAgent(
    job: Job<AgentChildJobData>,
  ): Promise<StepResult> {
    const {
      sessionId, agentId, goalId, prompt, toolCalls, context, initialMessages,
      toolChoice, autoExecuteTools, humanInTheLoop, resume, humanInputToolCallId, pendingMessages,
    } = job.data;

    const goal = this.goals.get(goalId);
    if (!goal) {
      return { agentId, goalId, history: [], status: 'active' };
    }

    const ragVectorStore = await this.getOrCreateRAGStore(agentId);

    const actionRequests = toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
      description: '',
    }));

    const result = await this.resolveGoalStep({
      goal,
      agentId,
      ragVectorStore,
      sessionId,
      context,
      initialMessages,
      prompt,
      attachments: job.data.attachments,
      command: resume,
      actionRequests,
      humanInputToolCallId,
      pendingMessages,
      toolChoice,
      autoExecuteTools: autoExecuteTools === true,
      humanInTheLoop: humanInTheLoop === true,
      onProgress: (progress) => job.updateProgress({ ...progress, sessionId, goalId }),
    });
    return { ...result, agentId, goalId };
  }

  // -----------------------------------------------------------------------
  // Shared goal step: builds messages, applies resume/prompt, runs agent loop
  // -----------------------------------------------------------------------

  private async resolveGoalStep(input: GoalStepInput): Promise<StepResult> {
    const {
      goal, agentId, ragVectorStore, sessionId, context, initialMessages,
      prompt, attachments, command, actionRequests, humanInputToolCallId, pendingMessages,
      toolChoice, autoExecuteTools, humanInTheLoop = false, onProgress,
    } = input;

    let tools: AgentTool[] = [...goal.tools];
    if (ragVectorStore && this.rag) {
      tools.push(
        createRetrieveTool({
          topK: this.rag.topK ?? 4,
          name: this.rag.retrieveToolName,
        }) as unknown as AgentTool,
      );
    }
    const toolContext =
      ragVectorStore != null ? { ...context, ragVectorStore } : context;

    const model = await this.createLLM(
      toToolDefinitions(tools, humanInTheLoop),
      { goalId: goal.id, context: toolContext },
    );

    const messages: BaseMessage[] = [
      new SystemMessage(buildAgentSystemMessage(goal, humanInTheLoop)),
    ];

    if (initialMessages?.length) {
      messages.push(...deserializeMessages(initialMessages));
    }

    const [orchResults, aggResults] = await Promise.all([
      fetchSessionResults(this.orchestratorQueue, sessionId),
      fetchSessionResults(this.aggregatorQueue, sessionId),
    ]);
    const goalHistory = [
      ...extractSingleGoalHistory(orchResults),
      ...extractAgentMessages(aggResults, goal.id),
    ];
    if (goalHistory.length) {
      messages.push(...deserializeMessages(goalHistory));
    }

    const restoredCount = messages.length;

    if (command) {
      switch (command.type) {
        case 'hitl_direct_reply': {
          if (humanInputToolCallId) {
            const { message } = command.payload;
            return {
              agentId,
              goalId: goal.id,
              history: serializeMessages([new AIMessage({ content: message })]),
              status: 'active',
            };
          }
          break;
        }
        case 'hitl_response': {
          if (humanInputToolCallId) {
            // Restore the AIMessage with tool_calls from pendingMessages so
            // the ToolMessage has a matching tool_call in context.
            if (pendingMessages?.length) {
              stripTrailingToolCalls(messages);
              messages.push(...deserializeMessages(pendingMessages));
            }
            const { message } = command.payload;
            messages.push(
              new ToolMessage({
                content: HUMAN_INPUT_TIP_PREFIX + message,
                tool_call_id: humanInputToolCallId,
              }),
            );
          }
          break;
        }
        case 'tool_approval': {
          if (actionRequests?.length) {
            // Restore the AIMessage with tool_calls so the ToolMessages have a matching tool_call in context.
            if (pendingMessages?.length) {
              stripTrailingToolCalls(messages);
              messages.push(...deserializeMessages(pendingMessages));
            }
            const toolMessages = await processToolApproval(command, actionRequests, tools, toolContext);
            messages.push(...toolMessages);
          }
          break;
        }
      }
    } else if (prompt !== undefined || attachments?.length) {
      stripTrailingToolCalls(messages);
      messages.push(new HumanMessage(buildHumanContent(prompt ?? '', attachments)));
    } else {
      return { agentId, goalId: goal.id, history: [], status: 'active' };
    }

    return this.runAgentLoop(
      goal, model, messages, restoredCount, toolContext, toolChoice, autoExecuteTools, onProgress, tools,
    );
  }

  // -----------------------------------------------------------------------
  // Agent loop: LLM -> tool-call -> execute cycle
  // -----------------------------------------------------------------------

  private async runAgentLoop(
    goal: AgentGoal,
    model: ConfigurableModel,
    messages: BaseMessage[],
    restoredCount: number,
    context?: Record<string, unknown>,
    toolChoice?: string | Record<string, unknown> | 'auto' | 'any' | 'none',
    autoExecuteTools = false,
    onProgress?: (progress: JobProgress) => void,
    tools: AgentTool[] = goal.tools,
    maxRounds = 5,
  ): Promise<StepResult> {
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
          history: serializeMessages(messages.slice(restoredCount)),
          status: 'active',
        };
      }

      // human_in_the_loop always requires user input — interrupt even when autoExecuteTools is true
      const humanInputCalls = response.tool_calls.filter((tc) => tc.name === HUMAN_IN_THE_LOOP_TOOL_NAME);
      if (humanInputCalls.length > 0) {
        return {
          goalId: goal.id,
          history: [],
          status: 'interrupted',
          interrupts: [{
            type: 'human_input',
            pendingMessages: serializeMessages([response]),
            actionRequests: humanInputCalls.map((tc) => ({
              id: tc.id ?? '',
              name: tc.name,
              arguments: tc.args,
              description: goal.tools.find((t) => t.name === tc.name)?.description ?? '',
            })),
            goalId: goal.id,
          }],
        };
      }

      if (!autoExecuteTools) {
        return {
          goalId: goal.id,
          history: serializeMessages(messages.slice(restoredCount)),
          status: 'interrupted',
          interrupts: [{
            type: 'tool_approval',
            pendingMessages: serializeMessages([response]),
            actionRequests: response.tool_calls.map((tc) => ({
              id: tc.id ?? '',
              name: tc.name,
              arguments: tc.args,
              description: goal.tools.find((t) => t.name === tc.name)?.description ?? '',
            })),
            goalId: goal.id,
          }],
        };
      }

      // Auto-execute tools
      for (const tc of response.tool_calls) {
        onProgress?.({ phase: 'executing-tool', toolName: tc.name });
        messages.push(
          await executeToolHandler(tc.name, tc.id ?? '', tc.args as Record<string, unknown>, tools, context),
        );
      }
    }

    return {
      goalId: goal.id,
      history: serializeMessages(messages.slice(restoredCount)),
      status: 'active',
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
    const rawChildren = await job.getChildrenValues<StepResult>();
    const childrenValues: Record<string, StepResult> = {};

    for (const result of Object.values(rawChildren)) {
      if (result?.goalId) {
        childrenValues[result.goalId] = result;
      }
    }

    // Omit childrenValues and interrupts from the stored return value; both are
    // already in each agent job's return value. Callers expand via
    // fetchAggregatorResultsWithChildren and derive interrupts from children.
    const status: StepResult['status'] =
      Object.values(childrenValues).some(
        (r) => r.status === 'interrupted' && r.interrupts?.length,
      )
        ? 'interrupted'
        : 'active';
    return {
      history: [],
      status,
    };
  }

  // -----------------------------------------------------------------------
  // Single-goal mode (thin wrapper around resolveGoalStep)
  // -----------------------------------------------------------------------

  private async getOrCreateRAGStore(agentId: string): Promise<Awaited<ReturnType<typeof getVectorStore>> | undefined> {
    if (!this.rag?.embedding) return undefined;

    let entry = this.ragCache.get(agentId);
    if (!entry) {
      const redisClient = await createRedisClient(this.connection);
      const store = await getVectorStore({
        redisClient,
        queuePrefix: this.queuePrefix,
        agentId,
        embedding: this.rag.embedding,
      });
      this.ragCache.set(agentId, { store, createdClient: redisClient });
      entry = { store, createdClient: redisClient };
    }
    return entry.store;
  }

  private async processSingleGoalStep(
    job: Job<OrchestratorJobData>,
    goalId: string,
    type: JobType,
    prompt: string | undefined,
    prevState: StepResult | null,
    sessionConfig: Required<SessionConfig>,
  ): Promise<StepResult> {
    const agentId = job.data.agentId;
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { history: [], agentId, goalId, status: 'active' };
    }

    const ragVectorStore = await this.getOrCreateRAGStore(agentId);

    const { sessionId, context, initialMessages, toolChoice } = job.data;
    const command = job.data.command;
    const onProgress = (progress: JobProgress) =>
      job.updateProgress({ ...progress, sessionId, goalId });

    let result: StepResult;

    if (type === 'command' && command && prevState?.status === 'interrupted') {
      const allActions = prevState.interrupts?.flatMap((i) => i.actionRequests) ?? [];
      const humanAction = allActions.find((a) => a.name === HUMAN_IN_THE_LOOP_TOOL_NAME);
      const hitlInterrupt = prevState.interrupts?.find((i) => i.type === 'human_input');

      result = await this.resolveGoalStep({
        goal,
        agentId,
        ragVectorStore,
        sessionId,
        context,
        initialMessages,
        command,
        actionRequests: allActions,
        humanInputToolCallId: humanAction?.id,
        pendingMessages: hitlInterrupt?.pendingMessages,
        toolChoice,
        autoExecuteTools: sessionConfig.autoExecuteTools,
        humanInTheLoop: sessionConfig.humanInTheLoop,
        onProgress,
      });
    } else if (type === 'prompt' && (prompt !== undefined || job.data.attachments?.length)) {
      result = await this.resolveGoalStep({
        goal,
        agentId,
        ragVectorStore,
        sessionId,
        context,
        initialMessages,
        prompt: prompt ?? '',
        attachments: job.data.attachments,
        toolChoice,
        autoExecuteTools: sessionConfig.autoExecuteTools,
        humanInTheLoop: sessionConfig.humanInTheLoop,
        onProgress,
      });
    } else {
      return { history: [], agentId, goalId, status: 'active' };
    }

    // When interrupting for human_in_the_loop, don't persist the AIMessage (to avoid orphan
    // tool_calls), but persist the user's prompt so later turns have the full conversation.
    if (
      result.status === 'interrupted' &&
      result.interrupts?.some((i) => i.type === 'human_input') &&
      (prompt !== undefined || job.data.attachments?.length)
    ) {
      result = {
        ...result,
        history: serializeMessages([
          new HumanMessage(buildHumanContent(prompt ?? '', job.data.attachments)),
        ]),
      };
    }

    return { ...result, agentId };
  }

  // -----------------------------------------------------------------------
  // Multi-goal helpers
  // -----------------------------------------------------------------------

  private async routeToGoals(
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
    agentId: string,
    goalIds: string[],
    prompt: string,
    sessionConfig: Required<SessionConfig>,
  ): Promise<string> {
    const { sessionId, context, initialMessages, toolChoice } = orchestratorJob.data;
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
      children: goalIds.map((goalId) => ({
        name: getJobNameFromGoalId(goalId),
        queueName: agentQueue,
        data: {
          sessionId,
          agentId,
          goalId,
          prompt,
          autoExecuteTools: sessionConfig.autoExecuteTools,
          humanInTheLoop: sessionConfig.humanInTheLoop,
          ...(context !== undefined && { context }),
          ...(initialMessages !== undefined && { initialMessages }),
          ...(orchestratorJob.data.attachments !== undefined && {
            attachments: orchestratorJob.data.attachments,
          }),
          ...(toolChoice !== undefined && { toolChoice }),
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
    agentId: string,
    awaitingAgents: [string, StepResult][],
    sessionConfig: Required<SessionConfig>,
  ): Promise<string> {
    const { sessionId, context, initialMessages } = orchestratorJob.data;
    const command = orchestratorJob.data.command;
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
      children: awaitingAgents.map(([goalId, result]) => {
        const toolApprovalInterrupt = result.interrupts?.find((i) => i.type === 'tool_approval');
        return {
          name: getJobNameFromGoalId(goalId),
          queueName: agentQueue,
          data: {
            sessionId,
            agentId,
            goalId,
            toolCalls: deriveToolCalls(result.history, goalId),
            autoExecuteTools: sessionConfig.autoExecuteTools,
            humanInTheLoop: sessionConfig.humanInTheLoop,
            ...(command !== undefined && { resume: command }),
            ...(toolApprovalInterrupt?.pendingMessages !== undefined && {
              pendingMessages: toolApprovalInterrupt.pendingMessages,
            }),
            ...(context !== undefined && { context }),
            ...(initialMessages !== undefined && { initialMessages }),
          } satisfies AgentChildJobData,
          opts: {
            jobId: `${sessionId}/${ts}/${goalId}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        };
      }),
    });

    return aggregatorJobId;
  }

  private async createHumanInputResponseFlow(
    orchestratorJob: Job<OrchestratorJobData>,
    agentId: string,
    goalId: string,
    humanInputToolCallId: string,
    command: ResumeCommand,
    pendingMessages?: SerializedMessage[],
    sessionConfig?: Required<SessionConfig>,
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
      children: [
        {
          name: getJobNameFromGoalId(goalId),
          queueName: agentQueue,
          data: {
            sessionId,
            agentId,
            goalId,
            resume: command,
            humanInputToolCallId,
            ...(sessionConfig && {
              autoExecuteTools: sessionConfig.autoExecuteTools,
              humanInTheLoop: sessionConfig.humanInTheLoop,
            }),
            ...(pendingMessages !== undefined && { pendingMessages }),
            ...(context !== undefined && { context }),
            ...(initialMessages !== undefined && { initialMessages }),
          } satisfies AgentChildJobData,
          opts: {
            jobId: `${sessionId}/${ts}/${goalId}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        },
      ],
    });

    return aggregatorJobId;
  }
}
