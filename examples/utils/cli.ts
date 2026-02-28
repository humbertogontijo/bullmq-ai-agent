import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';
import {
  deriveResponse,
  deriveToolCalls,
  type AgentResponseEvent,
  type ToolCall,
  type SerializedMessage,
  type StepResult,
} from '../../src/index.js';

const CONFIG_FILE = path.resolve(process.cwd(), '.agent.json');

const rl = createReadline();

function createReadline(): readline.Interface {
  return readline.createInterface({ input: stdin, output: stdout });
}

export async function askApiKey(): Promise<string> {
  const saved = loadConfig().apiKey;
  if (saved) {
    console.log('\x1b[2mUsing API key from .agent.json\x1b[0m');
    return saved;
  }

  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  const key = (await rl.question('Enter your OPENAI_API_KEY: ')).trim();
  if (!key) {
    console.log('No API key provided.');
    process.exit(1);
  }

  saveConfig({ apiKey: key });
  console.log('\x1b[2mAPI key saved to .agent.json\x1b[0m');
  return key;
}

export async function askInput(): Promise<string | null> {
  const input = await rl.question('\x1b[35mYou: \x1b[0m');
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') return null;
  return trimmed;
}

export async function askConfirm(): Promise<boolean> {
  const answer = await rl.question('\x1b[33mConfirm? (y/n): \x1b[0m');
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

export function printResult(result: StepResult): void {
  if (result.status === 'ended' || result.status === 'awaiting-confirm') return;
  for (const r of getResponses(result)) {
    console.log(`\x1b[36m[${r.goalId}]\x1b[0m ${r.text}\n`);
  }
}

export function printToolCalls(result: StepResult): void {
  const toolCalls = getToolCalls(result);
  console.log('\n\x1b[33mThe agent wants to execute:\x1b[0m');
  for (const tc of toolCalls) {
    console.log(`  \x1b[1m[${tc.goalId}] ${tc.name}\x1b[0m ${JSON.stringify(tc.args)}`);
  }
}

export function printHistory(messages: SerializedMessage[]): void {
  if (messages.length === 0) {
    console.log('\x1b[2m(no conversation history)\x1b[0m');
    return;
  }
  console.log('\n\x1b[1m=== Conversation History ===\x1b[0m');
  for (const m of messages) {
    switch (m.role) {
      case 'human':
        console.log(`\x1b[35mYou:\x1b[0m ${m.content}`);
        break;
      case 'ai':
        if (m.content) {
          console.log(`\x1b[36mAgent:\x1b[0m ${m.content}`);
        } else if (m.toolCalls?.length) {
          for (const tc of m.toolCalls) {
            console.log(`\x1b[36mAgent:\x1b[0m [calling ${tc.name}(${JSON.stringify(tc.args)})]`);
          }
        }
        break;
      case 'tool':
        console.log(`\x1b[33mTool:\x1b[0m ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''}`);
        break;
      default:
        break;
    }
  }
  console.log('\x1b[1m============================\x1b[0m\n');
}

export function closeInput(): void {
  rl.close();
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
      responses.push({ goalId: result.goalId ?? 'default', text: lastAi.content });
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, ...config }, null, 2) + '\n');
}
