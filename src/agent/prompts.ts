/**
 * Centralized prompts used by the agent, middlewares, and compile.
 * Aligned with LangChain style: XML-style tags (<role>, <instructions>) and ## sections
 * where applicable (e.g. summarization from langchain/dist/agents/middleware/summarization).
 */

/** Base system prompt for the deep agent (tool access instruction). */
export const BASE_PROMPT = `<role>
Assistant with access to tools
</role>

<instructions>
You have access to standard tools. Use them to complete the user's request.
</instructions>`;

// --- Summarization (from LangChain summarization middleware) ---

/**
 * Prompt template for the summarization model. Contains a single placeholder {messages}
 * that must be replaced with the formatted conversation history (e.g. via getBufferString).
 * @see node_modules/langchain/dist/agents/middleware/summarization.js DEFAULT_SUMMARY_PROMPT
 */
export const SUMMARIZATION_PROMPT_TEMPLATE = `<role>
Context Extraction Assistant
</role>

<primary_objective>
Your sole objective in this task is to extract the highest quality/most relevant context from the conversation history below.
</primary_objective>

<objective_information>
You're nearing the total number of input tokens you can accept, so you must extract the highest quality/most relevant pieces of information from your conversation history.
This context will then overwrite the conversation history presented below. Because of this, ensure the context you extract is only the most important information to your overall goal.
</objective_information>

<instructions>
The conversation history below will be replaced with the context you extract in this step. Because of this, you must do your very best to extract and record all of the most important context from the conversation history.
You want to ensure that you don't repeat any actions you've already completed, so the context you extract from the conversation history should be focused on the most important information to your overall goal.
</instructions>

The user will message you with the full message history you'll be extracting context from, to then replace. Carefully read over it all, and think deeply about what information is most important to your overall goal that should be saved:

With all of this in mind, please carefully read over the entire conversation history, and extract the most important and relevant context to replace it so that you can free up space in the conversation history.
Respond ONLY with the extracted context. Do not include any additional information, or text before or after the extracted context.

<messages>
Messages to summarize:
{messages}
</messages>`;

/**
 * Prefix for the system message that carries the previous conversation summary.
 * @see node_modules/langchain/dist/agents/middleware/summarization.js DEFAULT_SUMMARY_PREFIX
 */
export const PREVIOUS_CONVERSATION_SUMMARY_PREFIX =
  "Here is a summary of the conversation to date:";

/** Returns the full summary system message content (prefix + summary text). */
export function formatPreviousConversationSummary(summary: string): string {
  return `${PREVIOUS_CONVERSATION_SUMMARY_PREFIX}\n${summary}`;
}

// --- Skills (progressive disclosure) ---

/** Builds the "Available Skills" system prompt block when skills are configured. */
export function getSkillsPromptBlock(skills: { name: string; description: string }[]): string {
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
  return `

## Available Skills

${lines}

Use the \`load_skill\` tool to load full content for a skill when you need details.`;
}

/** Builds the load_skill tool description with the list of available skill names. */
export function getLoadSkillToolDescription(skillNames: string[]): string {
  return `Load a skill's full content for use in the current task.

## When to Use This Tool
Use when you need the full instructions or content for a skill that is listed in the Available Skills section. Call this tool before relying on skill-specific steps or guidelines.

## Available skill names
${skillNames.join(", ")}`;
}

// --- Tool: escalate_to_human ---

export const ESCALATE_TO_HUMAN_TOOL_DESCRIPTION = `Hand off the conversation to a human agent. Use when the user should be routed to a human and the agent should not continue.

## When to Use This Tool
- Complaints or sensitive issues that require human handling
- Requests that are out of scope for the agent
- Complex or ambiguous situations where human judgment is needed
- User explicitly asks to speak to a human

## When NOT to Use This Tool
- For simple approval or confirmation: use \`request_human_approval\` instead so the agent can resume after the user responds.
- For routine questions the agent can answer.`;

export const ESCALATE_TO_HUMAN_REASON_DESCRIPTION =
  "Reason for escalation (e.g. complaint, complex issue, out-of-scope, user asked for human).";

// --- Tool: request_human_approval ---

export const REQUEST_HUMAN_APPROVAL_TOOL_DESCRIPTION = `Pause for human approval or input. The run will wait until the user responds; then the agent continues with that input.

## When to Use This Tool
- You need a decision, confirmation, or clarification from the user before proceeding
- You want to show the user a message or question and wait for their reply
- The next step depends on user choice or approval

## When NOT to Use This Tool
- For full handoff to a human (no resume): use \`escalate_to_human\` instead.`;

export const REQUEST_HUMAN_APPROVAL_REASON_DESCRIPTION =
  "Message or question to show the human (e.g. approval request, clarification question).";

// --- Tool: load_skill ---

export const LOAD_SKILL_SKILL_NAME_DESCRIPTION =
  "Skill name. Must match one of the available skill names from the Available Skills section.";

// --- Tool: search_knowledge ---

export const SEARCH_KNOWLEDGE_TOOL_DESCRIPTION = `Search the knowledge base (RAG) for relevant documents.

## When to Use This Tool
Use when you need to find information from the agent's knowledge base: internal docs, FAQs, or other indexed content. Provide a clear search query.`;

export const SEARCH_KNOWLEDGE_QUERY_DESCRIPTION =
  "Search query. Use clear, descriptive terms for the information you need.";

export const SEARCH_KNOWLEDGE_K_DESCRIPTION =
  "Maximum number of results to return. Default is 5.";
