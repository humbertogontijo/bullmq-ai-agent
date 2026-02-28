import * as fs from 'node:fs';
import * as path from 'node:path';

import * as p from '@clack/prompts';

import {
  deriveResponse,
  deriveToolCalls,
  type AgentResponseEvent,
  type JobProgress,
  type SerializedMessage,
  type StepResult,
  type ToolCall,
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

export async function askConfirm(): Promise<boolean> {
  const answer = await p.confirm({
    message: 'Confirm tool execution?',
    initialValue: true,
  });

  if (p.isCancel(answer)) return false;
  return answer === true;
}

export function printResult(result: StepResult): void {
  if (result.status === 'ended' || result.status === 'awaiting-confirm') return;
  for (const r of getResponses(result)) {
    p.log.message(`${r.text}`, { symbol: `[${r.goalId}]` });
  }
}

export function printToolCalls(result: StepResult): void {
  const toolCalls = getToolCalls(result);
  p.log.message('The agent wants to execute:');
  for (const tc of toolCalls) {
    p.log.message(`  ${tc.name} ${JSON.stringify(tc.args)}`, {
      symbol: `[${tc.goalId}]`,
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

  if (result.agentResults) {
    for (const [goalId, r] of Object.entries(result.agentResults)) {
      const text = deriveResponse(r.messages);
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

export function getToolCalls(result: StepResult): ToolCall[] {
  const calls: ToolCall[] = [];
  if (result.toolCalls) calls.push(...result.toolCalls);
  if (result.agentResults) {
    for (const [goalId, r] of Object.entries(result.agentResults)) {
      if (r.status === 'awaiting-confirm') {
        calls.push(...deriveToolCalls(r.messages, goalId));
      }
    }
  }
  return calls;
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
