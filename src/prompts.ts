import type { AgentGoal, SerializedMessage } from './types.js';

/**
 * Build the system message for a single agent working toward a specific goal.
 */
export function buildAgentSystemMessage(
  goal: AgentGoal,
  multiGoalMode: boolean,
): string {
  const lines: string[] = [];

  lines.push(
    'You are an AI agent that helps the user accomplish the described goal using the available tools.',
    `The current date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`,
    '',
  );

  if (goal.systemMessage) {
    lines.push(goal.systemMessage, '');
  }

  lines.push('=== Goal ===', goal.description, '');

  lines.push(
    '=== Instructions ===',
    'Use the available tools to accomplish the goal described above.',
    'When you have all required arguments for a tool, call it.',
    'When you need more information from the user, ask a clear question.',
    'Carry forward arguments between related tool calls (e.g. same customer ID across tools).',
  );

  if (multiGoalMode) {
    lines.push(
      '',
      '=== Multi-Agent Mode ===',
      'You are one of several specialist agents. Focus only on your area of expertise.',
      'If the user asks about something outside your tools, say so briefly.',
    );
  }

  return lines.join('\n');
}

/**
 * Build the system message for the orchestrator that routes user prompts
 * to the appropriate agent(s).
 */
export function buildOrchestratorSystemMessage(
  goals: AgentGoal[],
): string {
  const agentDescriptions = goals
    .map(
      (g) =>
        `- id: "${g.id}" | name: "${g.agentName}" | description: "${g.agentFriendlyDescription}"`,
    )
    .join('\n');

  return [
    'You are a routing agent. Your job is to decide which specialist agents should handle the user\'s request.',
    `The current date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`,
    '',
    '=== Available Agents ===',
    agentDescriptions,
    '',
    '=== Instructions ===',
    'Given the user\'s message and conversation history, return a JSON array of agent IDs that should handle the request.',
    'Choose one or more agents based on what the user is asking for.',
    'If the user\'s intent is unclear, include all agents that could be relevant.',
    '',
    'Respond with ONLY a valid JSON array of agent ID strings. Examples:',
    '["flight"]',
    '["flight", "hr"]',
    '["hr"]',
  ].join('\n');
}

/**
 * Format conversation history into a compact string for the orchestrator.
 */
export function formatHistoryForOrchestrator(
  history: SerializedMessage[],
): string {
  if (history.length === 0) return '';

  const relevant = history.filter((m) => m.role === 'human' || m.role === 'ai');
  if (relevant.length === 0) return '';

  const lines = relevant.map((m) => {
    const role = m.role === 'human' ? 'User' : 'Agent';
    const text =
      m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
    return `${role}: ${text}`;
  });

  return ['=== Recent Conversation ===', ...lines].join('\n');
}
