import * as fs from 'node:fs';
import * as path from 'node:path';

import * as p from '@clack/prompts';

import {
  deriveResponse,
  type AgentResponseEvent,
  type HumanDirectReplyCommand,
  type HumanResponseCommand,
  type JobProgress,
  type ResumeCommand,
  type SerializedMessage,
  type StepResult,
} from '../../src/index.js';

const CONFIG_FILE = path.resolve(process.cwd(), '.agent.json');

export function progressLabel(progress: JobProgress): string {
  switch (progress.phase) {
    case 'prompt-read':
      return 'Prompt received';
    case 'routing':
      return 'Routing to agents...';
    case 'thinking':
      return 'AI is thinking...';
    case 'typing':
      return 'AI is typing...';
    case 'executing-tool':
      return progress.toolName
        ? `Running ${progress.toolName}...`
        : 'Running tool...';
    case 'aggregating':
      return 'Aggregating results...';
    default:
      return 'Processing...';
  }
}

export async function askApiKey(): Promise<string> {
  const saved = loadConfig().apiKey;
  if (saved) {
    p.log.message('Using API key from .agent.json');
    return saved;
  }

  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  const key = await p.text({
    message: 'Enter your OPENAI_API_KEY',
    placeholder: 'sk-...',
    validate: (value) => {
      if (!value.trim()) return 'API key is required';
    },
  });

  if (p.isCancel(key)) {
    p.cancel('No API key provided.');
    process.exit(1);
  }

  const trimmed = String(key).trim();
  if (!trimmed) {
    p.cancel('No API key provided.');
    process.exit(1);
  }

  saveConfig({ apiKey: trimmed });
  p.log.message('API key saved to .agent.json');
  return trimmed;
}

/** Main chat: user sends a new message to the agent. */
export async function askInput(): Promise<string | null> {
  const input = await p.text({
    message: 'You',
    placeholder: 'Type your message (or exit to quit)',
  });

  if (p.isCancel(input)) return null;

  const trimmed = String(input).trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
    return null;
  }
  return trimmed;
}

/** Human-in-the-loop: operator tips the agent or sends a direct reply. Returns a ResumeCommand. */
export async function askOperatorIntervention(): Promise<HumanResponseCommand | HumanDirectReplyCommand | null> {
  const mode = await p.select({
    message: 'Operator: how do you want to respond?',
    options: [
      { value: 'tip', label: 'Tip the agent (agent will use your text to formulate the reply)' },
      { value: 'direct', label: 'Send as the agent (your text is shown as the agent\u2019s reply)' },
      { value: 'skip', label: 'Skip / exit' },
    ],
  });

  if (p.isCancel(mode) || mode === 'skip') return null;

  const input = await p.text({
    message: mode === 'tip' ? 'Tip for the agent' : 'Reply as the agent',
    placeholder: 'Type your message, or exit to cancel',
  });

  if (p.isCancel(input)) return null;

  const message = String(input).trim();
  if (!message) return askOperatorIntervention();
  if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') return null;

  return mode === 'tip'
    ? { type: 'hitl_response', payload: { message } }
    : { type: 'hitl_direct_reply', payload: { message } };
}

export async function askConfirm(): Promise<boolean> {
  const answer = await p.confirm({
    message: 'Confirm tool execution?',
    initialValue: true,
  });

  if (p.isCancel(answer)) return false;
  return answer === true;
}

/** Check if any interrupt in the result is a human_input interrupt. */
export function hasHumanInputInterrupt(result: StepResult): boolean {
  if (result.interrupts?.some((i) => i.type === 'human_input')) return true;
  if (result.childrenValues) {
    for (const r of Object.values(result.childrenValues)) {
      if (r.interrupts?.some((i) => i.type === 'human_input')) return true;
    }
  }
  return false;
}

export function printResult(result: StepResult): void {
  if (result.status === 'ended' || result.status === 'interrupted') return;
  for (const r of getResponses(result)) {
    p.log.message(`${r.text}`, { symbol: `[${r.goalId}]` });
  }
}

export function printToolCalls(result: StepResult): void {
  const actions = getAllActionRequests(result);
  if (actions.length === 0) return;
  p.log.message('Pending actions (use sendCommand to approve/reject or reply):');
  for (const { goalId, name, description } of actions) {
    p.log.message(`  [${goalId ?? result.goalId ?? '?'}] ${name}: ${description}`, {
      symbol: '\u2022',
    });
  }
}

export function printHistory(messages: SerializedMessage[]): void {
  if (messages.length === 0) {
    p.log.message('(no conversation history)');
    return;
  }
  p.note(
    messages
      .map((m) => {
        switch (m.role) {
          case 'human':
            return `You: ${m.content}`;
          case 'ai':
            if (m.content) return `Agent: ${m.content}`;
            if (m.toolCalls?.length) {
              return m.toolCalls
                .map(
                  (tc) =>
                    `Agent: [calling ${tc.name}(${JSON.stringify(tc.args)})]`,
                )
                .join('\n');
            }
            return '';
          case 'tool':
            return `Tool: ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''}`;
          default:
            return '';
        }
      })
      .filter(Boolean)
      .join('\n\n'),
    'Conversation History',
  );
}

export function closeInput(): void {
  // No-op: @clack/prompts does not keep a persistent readline
}

export function getResponses(result: StepResult): AgentResponseEvent[] {
  const responses: AgentResponseEvent[] = [];

  if (result.childrenValues) {
    for (const [goalId, r] of Object.entries(result.childrenValues)) {
      const text = deriveResponse(r.history);
      if (text) responses.push({ goalId, text });
    }
  }

  if (responses.length === 0 && result.history?.length) {
    const lastAi = [...result.history]
      .reverse()
      .find((m) => m.role === 'ai' && m.content);
    if (lastAi) {
      responses.push({
        goalId: result.goalId ?? 'default',
        text: lastAi.content,
      });
    }
  }

  return responses;
}


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ActionRequestWithGoalId {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  description: string;
  goalId?: string;
}

function getAllActionRequests(result: StepResult): ActionRequestWithGoalId[] {
  const out: ActionRequestWithGoalId[] = [];
  if (result.interrupts?.length) {
    for (const i of result.interrupts) {
      if (i.actionRequests?.length) {
        out.push(...i.actionRequests.map((ar) => ({ ...ar, goalId: i.goalId })));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// .agent.json config persistence
// ---------------------------------------------------------------------------

interface AgentConfig {
  apiKey?: string;
}

function loadConfig(): AgentConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return {};
  }
}

function saveConfig(config: AgentConfig): void {
  const existing = loadConfig();
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...existing, ...config }, null, 2) + '\n',
  );
}
