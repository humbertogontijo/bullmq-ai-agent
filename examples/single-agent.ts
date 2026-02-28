/**
 * Single-agent example: Flight Finder
 *
 * One goal → direct agent processing, no orchestrator routing.
 * Session persists across runs — restart and pick up where you left off.
 * Uses @clack/prompts and job progress (thinking, typing, tool-calling).
 *
 * Run: npx tsx examples/single-agent.ts
 */

import * as p from '@clack/prompts';

import { AgentClient, AgentWorker, type AgentGoal } from '../src/index.js';
import {
  askApiKey,
  askConfirm,
  askInput,
  closeInput,
  printHistory,
  printResult,
  printToolCalls,
  progressLabel,
} from './utils/cli.js';
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
  p.intro('Flight Finder (single-agent)');

  const apiKey = await askApiKey();

  const worker = new AgentWorker({
    connection: REDIS,
    llmConfig: async () => ({ model: 'openai:gpt-4o', apiKey }),
    goals: [flightGoal],
  });

  const client = new AgentClient({ connection: REDIS });

  await worker.start();

  const sessionId = `session-1`;

  const history = await client.getConversationHistory(sessionId);
  if (history.length > 0) {
    p.log.message('Resuming previous conversation...');
    printHistory(history);
  }

  while (true) {
    const input = await askInput();
    if (input === null) break;
    if (input === '') continue;

    const progressSpinner = p.spinner();
    progressSpinner.start('Sending...');

    let result = await client.sendPrompt(sessionId, input, {
      autoExecuteTools: true,
      onProgress: (progress) => progressSpinner.message(progressLabel(progress)),
    });

    progressSpinner.stop('Done');
    printResult(result);

    while (result.status === 'awaiting-confirm') {
      printToolCalls(result);
      if (await askConfirm()) {
        const confirmSpinner = p.spinner();
        confirmSpinner.start('Confirming...');
        result = await client.confirm(sessionId, undefined, {
          onProgress: (progress) =>
            confirmSpinner.message(progressLabel(progress)),
        });
        confirmSpinner.stop('Done');
        printResult(result);
      } else {
        break;
      }
    }
  }

  closeInput();
  await client.close();
  await worker.close();

  p.outro('Goodbye!');
  process.exit(0);
}

main().catch(console.error);
