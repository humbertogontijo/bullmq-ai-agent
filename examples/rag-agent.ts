/**
 * RAG example: agent worker with RAG enabled, one agent, one goal.
 *
 * - Worker is started with rag: { embedding, topK } so it runs the document queue and injects the "retrieve" tool.
 * - addDocument(agentId, source) sends to the worker; worker ingests using its rag.embedding.
 *
 * Run: npx tsx examples/rag-agent.ts
 * Requires: Redis with RediSearch (e.g. Redis Stack), OPENAI_API_KEY, and @langchain/openai for embeddings.
 *   Docker: docker run -d -p 6379:6379 redis/redis-stack
 */

import * as p from '@clack/prompts';

import { AgentClient, AgentWorker, type Agent, type AgentGoal } from '../src/index.js';
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

const REDIS = { host: 'localhost', port: 6379 };

const goal: AgentGoal = {
  id: 'qa',
  name: 'Q&A',
  title: 'Answer questions using your knowledge base',
  description:
    'Answer the user\'s questions. Use the retrieve tool to look up relevant context from your knowledge base before answering.',
  tools: [],
};

const AGENT_ID = 'rag-agent';

async function main() {
  p.intro('RAG Agent (knowledge base + retrieve tool)');

  const apiKey = await askApiKey();

  const worker = new AgentWorker({
    connection: REDIS,
    llmConfig: async () => ({ model: 'openai:gpt-4o', apiKey }),
    goals: [goal],
    rag: {
      embedding: { provider: 'openai', model: 'text-embedding-3-small' },
      topK: 4,
    }
  });

  const client = new AgentClient({ connection: REDIS, queuePrefix: '1234' });

  await worker.start();

  const sessionId = 'rag-example-session';

  // Index some text so the agent has something to retrieve (client sends to worker; worker uses ragOptions)
  try {
    await client.addDocument(AGENT_ID, {
      type: 'text',
      text: 'The bullmq-ai-agent library uses BullMQ for job queues and LangChain for the LLM and tools. Each agent can have a RAG knowledge base stored in Redis (RedisVectorStore). Goals are fixed objectives; multiple agents can share the same goals.',
    });
    p.log.success('Indexed sample document for the agent.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('FT.INFO') || msg.includes('RediSearch')) {
      p.log.warn('RAG indexing needs Redis with RediSearch (e.g. Redis Stack). Use: docker run -d -p 6379:6379 redis/redis-stack');
    } else {
      p.log.warn('Could not index document (e.g. install @langchain/openai or use Redis Stack). Continuing anyway.');
    }
    p.log.message(msg);
  }

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

    let result = await client.sendPrompt(AGENT_ID, sessionId, input, {
      onProgress: (progress) => progressSpinner.message(progressLabel(progress)),
      goalId: goal.id,
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
        result = await client.sendCommand(AGENT_ID, sessionId, intervention, {
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
          result = await client.sendCommand(AGENT_ID, sessionId, { type: 'tool_approval', payload: { approved } }, {
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
