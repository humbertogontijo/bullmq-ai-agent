/**
 * Multi-agent example: Flight Finder + HR Assistant
 *
 * Two goals → orchestrator LLM routes each prompt to the right agent(s),
 * which run in parallel via BullMQ Flows.
 * Session persists across runs — restart and pick up where you left off.
 *
 * Run: npx tsx examples/multi-agent.ts
 */

import { AgentClient, AgentWorker, type AgentGoal } from '../src/index.js';
import { askApiKey, askConfirm, askInput, closeInput, printHistory, printResult, printToolCalls } from './utils/cli.js';
import { bookFlight, bookPTO, checkPTO, searchFlights } from './utils/tools.js';

const REDIS = { host: 'localhost', port: 6379 };

// --- Define goals ---

const flightGoal: AgentGoal = {
  id: 'flight-booking',
  agentName: 'Flight Finder',
  agentFriendlyDescription: 'Search and book flights to any destination',
  description:
    'Help the user find and book flights. ' +
    '1. Use SearchFlights to find available options. ' +
    '2. Use BookFlight to book the chosen flight.',
  tools: [searchFlights, bookFlight],
};

const hrGoal: AgentGoal = {
  id: 'hr-pto',
  agentName: 'HR Assistant',
  agentFriendlyDescription: 'Check PTO balance and schedule time off',
  description:
    'Help with PTO management. ' +
    '1. Use CheckPTO to look up available days. ' +
    '2. Use BookPTO to schedule time off.',
  tools: [checkPTO, bookPTO],
};

// --- Chat loop ---

async function main() {
  const apiKey = await askApiKey();

  const worker = new AgentWorker({
    connection: REDIS,
    llm: { model: 'openai:gpt-4o', apiKey },
    goals: [flightGoal, hrGoal],
    showConfirmation: true,
  });

  const client = new AgentClient({ connection: REDIS });

  await worker.start();

  const sessionId = `session-2`;

  const history = await client.getConversationHistory(sessionId);
  if (history.length > 0) {
    console.log('\x1b[2mResuming previous conversation...\x1b[0m');
    printHistory(history);
  }

  while (true) {
    const input = await askInput();
    if (input === null) break;
    if (input === '') continue;

    let result = await client.sendPrompt(sessionId, input);
    printResult(result);

    while (result.status === 'awaiting-confirm') {
      printToolCalls(result);
      if (await askConfirm()) {
        result = await client.confirm(sessionId);
        printResult(result);
      } else {
        break;
      }
    }
  }

  closeInput();
  await client.close();
  await worker.close();
  process.exit(0);
}

main().catch(console.error);
