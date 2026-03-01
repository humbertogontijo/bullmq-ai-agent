/**
 * Multi-agent example: Flight Finder + HR Assistant
 *
 * Two goals → orchestrator LLM routes each prompt to the right agent(s),
 * which run in parallel via BullMQ Flows.
 * Session persists across runs — restart and pick up where you left off.
 * Uses @clack/prompts and job progress (routing, thinking, typing, etc.).
 *
 * Run: npx tsx examples/multi-agent.ts
 */

import * as p from '@clack/prompts';

import { AgentClient, AgentWorker, type AgentGoal } from '../src/index.js';
import {
  askApiKey,
  askConfirm,
  askInput,
  askOperatorIntervention,
  closeInput,
  hasHumanInputInterrupt,
  printHistory,
  printResult,
  printToolCalls,
  progressLabel,
} from './utils/cli.js';
import { bookFlight, bookPTO, checkPTO, searchFlights } from './utils/tools.js';

const REDIS = { host: 'localhost', port: 6379 };

// --- Define goals ---

const flightGoal: AgentGoal = {
  id: 'flight-booking',
  name: 'Flight Finder',
  title: 'Search and book flights to any destination',
  description:
    'Help the user find and book flights. ' +
    '1. Use SearchFlights to find available options. ' +
    '2. Use BookFlight to book the chosen flight.',
  tools: [searchFlights, bookFlight],
};

const hrGoal: AgentGoal = {
  id: 'hr-pto',
  name: 'HR Assistant',
  title: 'Check PTO balance and schedule time off',
  description:
    'Help with PTO management. ' +
    '1. Use CheckPTO to look up available days. ' +
    '2. Use BookPTO to schedule time off.',
  tools: [checkPTO, bookPTO],
};

// --- Chat loop ---

async function main() {
  p.intro('Flight Finder + HR Assistant (multi-agent)');

  const apiKey = await askApiKey();

  const worker = new AgentWorker({
    connection: REDIS,
    llmConfig: async () => ({ model: 'openai:gpt-4o', apiKey }),
    goals: [flightGoal, hrGoal],
  });

  const client = new AgentClient({ connection: REDIS });

  await worker.start();

  const sessionId = 'example-session';

  await client.setSessionConfig(sessionId, {
    humanInTheLoop: true,
    autoExecuteTools: false,
  });

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
      onProgress: (progress) => progressSpinner.message(progressLabel(progress)),
    });

    progressSpinner.stop('Done');
    printResult(result);

    while (result.status === 'interrupted') {
      printToolCalls(result);

      if (hasHumanInputInterrupt(result)) {
        const intervention = await askOperatorIntervention();
        if (intervention === null) break;
        const humanSpinner = p.spinner();
        humanSpinner.start('Sending...');
        result = await client.sendCommand(sessionId, intervention, {
          onProgress: (progress) => humanSpinner.message(progressLabel(progress)),
        });
        humanSpinner.stop('Done');
        printResult(result);
      } else {
        if (await askConfirm()) {
          const confirmSpinner = p.spinner();
          confirmSpinner.start('Confirming...');
          const actionRequests = result.interrupts?.flatMap((i) => i.actionRequests) ?? [];
          const approved = Object.fromEntries(
            actionRequests.map((a) => [a.name, true]),
          );
          result = await client.sendCommand(sessionId, { type: 'tool_approval', payload: { approved } }, {
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
  }

  closeInput();
  await client.close();
  await worker.close();

  p.outro('Goodbye!');
  process.exit(0);
}

main().catch(console.error);
