/**
 * Single-agent example: Flight Finder
 *
 * One goal → direct agent processing, no orchestrator routing.
 * Session persists across runs — restart and pick up where you left off.
 *
 * Run: npx tsx examples/single-agent.ts
 */

import { AgentClient, AgentWorker, type AgentGoal } from '../src/index.js';
import { askApiKey, askConfirm, askInput, closeInput, printHistory, printResult, printToolCalls } from './utils/cli.js';
import { bookFlight, searchFlights } from './utils/tools.js';

const REDIS = { host: 'localhost', port: 6379 };

// --- Define goal ---

const flightGoal: AgentGoal = {
  id: 'flight-booking',
  agentName: 'Flight Finder',
  agentFriendlyDescription: 'Search and book flights',
  description:
    'Help the user find and book flights. ' +
    '1. SearchFlights to find options. ' +
    '2. BookFlight to complete the booking.',
  tools: [searchFlights, bookFlight],
};

// --- Chat loop ---

async function main() {
  const apiKey = await askApiKey();

  const worker = new AgentWorker({
    connection: REDIS,
    llm: { model: 'openai:gpt-4o', apiKey },
    goals: [flightGoal],
    showConfirmation: true,
  });

  const client = new AgentClient({ connection: REDIS });

  await worker.start();

  const sessionId = `session-1`;

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
