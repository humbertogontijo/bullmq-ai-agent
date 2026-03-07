import { BaseMessage, mapStoredMessagesToChatMessages, StoredMessage, SystemMessage, SystemMessageFields, ToolMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  END,
  interrupt,
  isGraphInterrupt,
  START,
  StateGraph
} from "@langchain/langgraph";
import type { FlowProducer, Queue } from "bullmq";
import { initChatModel } from "langchain";
import type { ModelOptions, RunContext } from "../options.js";
import { QUEUE_NAMES } from "../options.js";
import type { AggregatorJobData, ToolJobData } from "../queues/types.js";
import { getLastAIMessage, getToolCallIdsWithResponses } from "../utils/message.js";
import { nextSnowflakeId } from "../utils/snowflake.js";
import type { AgentStateType } from "./state.js";
import { AgentState } from "./state.js";

/** Goal: id plus system prompt and optional custom tools used when this goal is selected for a run. */
export interface Goal {
  id: string;
  systemPrompt: SystemMessageFields[];
  /** Optional tools to add for this goal (merged with orchestrator context tools). */
  tools?: StructuredToolInterface[];
}

/** Context bound when building the graph (worker-held queues and vector stores by agentId). */
export interface OrchestratorContext {
  tools: StructuredToolInterface[];
  toolsQueue: Queue<ToolJobData>;
  flowProducer: FlowProducer;
  /** Optional goals; when a run/resume sets goal to an id, that goal's systemPrompt is used for the model. */
  goals?: Goal[];
  /** Async function returning system prompt for an agent. Order: goal systemPrompt (if set), then this, then messages. */
  agentSystemPrompt?: (agentId: string) => Promise<SystemMessageFields[]>;
}

const internalTools = ["request_human_approval"];

async function createLlm(opts: ModelOptions, tools: StructuredToolInterface[]) {
  const llm = await initChatModel(`${opts.provider}:${opts.model}`, {
    apiKey: opts.apiKey,
    temperature: 0.3,
    maxTokens: 300
  });
  return llm.bindTools(tools);
}

async function hookNode(
  state: AgentStateType,
  runnableConfig?: LangGraphRunnableConfig
): Promise<Partial<AgentStateType>> {
  if (!runnableConfig) return {};
  const configurable = runnableConfig.configurable as RunContext;
  const job = configurable?.job;
  if (job?.updateProgress) {
    await job.updateProgress({ stage: runnableConfig.runName });
  }
  return state;
};

function createModelNode(ctx: OrchestratorContext) {
  const { tools, goals, agentSystemPrompt } = ctx;
  return async function modelNode(
    state: AgentStateType,
    runnableConfig?: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType>> {
    if (!runnableConfig) return {};
    const configurable = runnableConfig.configurable as RunContext;
    const chatModelOptions = configurable.chatModelOptions ?? state.chatModelOptions;
    if (!chatModelOptions) throw new Error("chatModelOptions required (pass in run or reuse from checkpoint on resume)");
    const agentId = configurable.agentId;
    const goalId = state.goalId ?? configurable.goalId;
    const goal = goalId ? goals?.find((g) => g.id === goalId) : undefined;
    const goalSystemPrompt = goal?.systemPrompt;
    const effectiveTools = [...tools, ...(goal?.tools ?? [])];
    const agentPrompt = agentSystemPrompt ? await agentSystemPrompt(agentId) : undefined;
    const llm = await createLlm(chatModelOptions, effectiveTools);
    const goalMessages: BaseMessage[] = goalSystemPrompt?.length
      ? goalSystemPrompt.map((s) => new SystemMessage(s))
      : [];
    const agentMessages: BaseMessage[] = agentPrompt?.length
      ? agentPrompt.map((s: SystemMessageFields) => new SystemMessage(s))
      : [];
    const messages = [...goalMessages, ...agentMessages, ...state.messages];
    const response = await llm.invoke(messages);
    return { chatModelOptions, messages: [response] };
  };
}

function createExecuteToolNode(ctx: OrchestratorContext) {
  const { tools, goals, flowProducer } = ctx;
  return async function executeToolNode(
    state: AgentStateType,
    runnableConfig: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType> & { messages: AgentStateType["messages"] }> {
    if (!runnableConfig) return { messages: [] };
    const configurable = runnableConfig.configurable as RunContext;
    const checkpointThreadId = configurable.thread_id;
    const agentId = configurable.agentId;
    const goalId = state.goalId ?? configurable.goalId;
    const goal = goalId ? goals?.find((g) => g.id === goalId) : undefined;
    const effectiveTools = [...tools, ...(goal?.tools ?? [])];
    const chatModelOptions = configurable.chatModelOptions ?? state.chatModelOptions;
    const clientThreadId = checkpointThreadId.includes(":") ? checkpointThreadId.split(":")[1]! : checkpointThreadId;

    const aiMsg = getLastAIMessage(state.messages);
    if (!aiMsg?.tool_calls?.length) {
      return { messages: [] };
    }

    const responded = getToolCallIdsWithResponses(state.messages);
    const pending = aiMsg.tool_calls.filter((tc) => tc.id && !responded.has(tc.id));
    if (pending.length === 0) {
      return { messages: [] };
    }

    const pendingInternalTools = pending.filter((tc) => internalTools.includes(tc.name));
    const pendingExternalTools = pending.filter((tc) => !internalTools.includes(tc.name));
    const flowChildren: Array<{ name: string; queueName: string; data: ToolJobData; opts?: { jobId: string } }> = [];

    for (const tc of pendingExternalTools) {
      const toolCallId = tc.id ?? `tc-${Date.now()}-${tc.name}`;
      const args = (tc.args as Record<string, unknown>) ?? {};
      flowChildren.push({
        name: "run",
        queueName: QUEUE_NAMES.TOOLS,
        data: {
          agentId,
          toolName: tc.name,
          args,
          toolCallId,
          threadId: clientThreadId,
        },
        opts: { jobId: nextSnowflakeId() },
      });
    }

    if (flowChildren.length > 0) {
      const aggregatorData: AggregatorJobData = {
        agentId,
        threadId: clientThreadId,
        chatModelOptions: chatModelOptions!,
        goalId: configurable.goalId,
      };
      const aggregatorJobId = `agg-${nextSnowflakeId()}`;
      try {
        const { messages }: { messages: StoredMessage[] } = interrupt({
          type: "aggregator",
          aggregatorJobId,
        });
        return { messages: mapStoredMessagesToChatMessages(messages) };
      } catch (err) {
        if (!isGraphInterrupt(err)) throw err;
        await flowProducer.add({
          name: "aggregate",
          queueName: QUEUE_NAMES.AGGREGATOR,
          data: aggregatorData,
          opts: { jobId: aggregatorJobId },
          children: flowChildren,
        });
        throw err;
      }
    }

    const messages = await Promise.all(
      pendingInternalTools.map(
        async (tc) => {
          const toolCallId = tc.id ?? `tc-${Date.now()}-${tc.name}`;
          const t = effectiveTools.find((t) => t.name === tc.name);
          const result = t ? await t.invoke(tc.args, runnableConfig) : undefined;
          return new ToolMessage({
            content: typeof result === "string" ? result : JSON.stringify(result ?? {}),
            tool_call_id: toolCallId,
          })
        }
      )
    );
    return { messages };
  };
}

function routeAfterTool(state: AgentStateType): "before_agent" | "after_agent" {
  // After adding tool responses, always loop back to the model so it can produce the next message.
  const aiMsg = getLastAIMessage(state.messages);
  if (!aiMsg?.tool_calls?.length) return "after_agent";
  return "before_agent";
}

export function buildOrchestratorGraph(context: OrchestratorContext) {
  const builder = new StateGraph(AgentState)
    .addNode("before_agent", hookNode)
    .addNode("before_model", hookNode)
    .addNode("model", createModelNode(context))
    .addNode("after_model", hookNode)
    .addNode("after_agent", hookNode)
    .addNode("execute_tool", createExecuteToolNode(context))
    .addEdge(START, "before_agent")
    .addEdge("before_agent", "before_model")
    .addEdge("before_model", "model")
    .addEdge("model", "after_model")
    .addEdge("after_model", "execute_tool")
    .addConditionalEdges("execute_tool", routeAfterTool, { before_agent: "before_agent", after_agent: "after_agent" })
    .addEdge("after_agent", END);

  return builder;
}
