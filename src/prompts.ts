import type { AgentGoal, SerializedMessage } from './types.js';

// ---------------------------------------------------------------------------
// Prompt constants (used by worker.ts when building tool messages)
// ---------------------------------------------------------------------------

export const DEFAULT_REJECTION = 'The user declined to run this action.';

export const HUMAN_INPUT_TIP_PREFIX =
  'Operator tip (relay this to the user as your reply): ';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Agent system message
// ---------------------------------------------------------------------------

export function buildAgentSystemMessage(
  goal: AgentGoal,
  humanInTheLoop = false,
): string {
  const lines: string[] = [];

  if (humanInTheLoop) {
    lines.push(
      `You are ${goal.name}. Today is ${today()}.`,
      '',
      `Goal: ${goal.title}`,
      goal.description,
      '',
    );
    if (goal.systemMessage) {
      lines.push(goal.systemMessage, '');
    }
    lines.push(
      'Use tools to help with requests related to your goal.',
      'For off-topic requests, call human_in_the_loop to redirect or get guidance.',
      'When human_in_the_loop returns a response, relay it to the user as your answer.',
    );
  } else {
    lines.push(
      `You are an AI agent. Today is ${today()}.`,
      '',
    );
    if (goal.systemMessage) {
      lines.push(goal.systemMessage, '');
    }
    lines.push(
      `Goal: ${goal.description}`,
      '',
      'Use tools to accomplish the goal. Call a tool when you have the required arguments. Ask the user when you need more information.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator system message (multi-goal routing)
// ---------------------------------------------------------------------------

export function buildOrchestratorSystemMessage(
  goals: AgentGoal[],
): string {
  const agentList = goals
    .map((g) => `- "${g.id}": ${g.title}`)
    .join('\n');

  return [
    `You are a routing agent. Today is ${today()}.`,
    '',
    'Agents:',
    agentList,
    '',
    'Return a JSON array of agent IDs that should handle the user\'s request.',
    'Example: ["flight"] or ["flight","hr"]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// History formatting for orchestrator context
// ---------------------------------------------------------------------------

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

  return ['Recent conversation:', ...lines].join('\n');
}
