/**
 * Centralized prompts used by the agent, middlewares, and compile.
 * Kept concise for lower token usage and clearer model behavior.
 */

/** Base system prompt for the deep agent (tool access instruction). */
export const BASE_PROMPT =
  "You have access to standard tools. Use them to complete the user's request.";

// --- Summarization ---

/** System message for the summarization model. */
export const SUMMARIZATION_SYSTEM_MESSAGE =
  "You summarize conversations. Preserve key facts, decisions, and context needed to continue.";

/** User prompt sent to the summarization model with the conversation history. */
export const SUMMARIZATION_USER_PROMPT =
  "Summarize the following conversation concisely. Preserve key facts, decisions, and context needed to continue.";

/** Prefix for the system message that carries the previous conversation summary. */
export const PREVIOUS_CONVERSATION_SUMMARY_PREFIX = "[Previous conversation summary]";

/** Returns the full summary system message content (prefix + summary text). */
export function formatPreviousConversationSummary(summary: string): string {
  return `${PREVIOUS_CONVERSATION_SUMMARY_PREFIX}\n${summary}`;
}

// --- Skills (progressive disclosure) ---

/** Builds the "Available Skills" system prompt block when skills are configured. */
export function getSkillsPromptBlock(skills: { name: string; description: string }[]): string {
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
  return `\n\n## Available Skills\n\n${lines}\n\nUse load_skill to load full content for a skill.`;
}

/** Builds the load_skill tool description with the list of available skill names. */
export function getLoadSkillToolDescription(skillNames: string[]): string {
  return `Load a skill's full content. Use when you need details. Available: ${skillNames.join(", ")}.`;
}

// --- Tool: escalate_to_human ---

export const ESCALATE_TO_HUMAN_TOOL_DESCRIPTION =
  "Hand off the conversation to a human. Use for complaints, complex issues, or out-of-scope requests. For simple approval use request_human_approval instead.";

export const ESCALATE_TO_HUMAN_REASON_DESCRIPTION =
  "Reason for escalation (e.g. complaint, complex issue, out-of-scope).";

// --- Tool: request_human_approval ---

export const REQUEST_HUMAN_APPROVAL_TOOL_DESCRIPTION =
  "Pause for human approval or input. Include the message to show the human.";

export const REQUEST_HUMAN_APPROVAL_REASON_DESCRIPTION =
  "Message or question to show the human.";

// --- Tool: load_skill ---

export const LOAD_SKILL_SKILL_NAME_DESCRIPTION =
  "Skill name (must match the configured skills list).";

// --- Tool: search_knowledge ---

export const SEARCH_KNOWLEDGE_TOOL_DESCRIPTION =
  "Search the knowledge base (RAG) for relevant documents.";

export const SEARCH_KNOWLEDGE_QUERY_DESCRIPTION = "Search query.";

export const SEARCH_KNOWLEDGE_K_DESCRIPTION = "Max number of results to return.";
