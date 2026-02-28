import { describe, it, expect } from 'vitest';
import {
  extractSingleGoalHistory,
  extractAgentMessages,
  buildConversationHistory,
  deriveResponse,
  deriveToolCalls,
  deriveRoutingHistory,
} from '../src/history.js';
import type { StepResult, SerializedMessage, AgentChildResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(role: SerializedMessage['role'], content: string, extra?: Partial<SerializedMessage>): SerializedMessage {
  return { role, content, ...extra };
}

function stepResult(overrides: Partial<StepResult>): StepResult {
  return { history: [], status: 'active', ...overrides };
}

// ---------------------------------------------------------------------------
// extractSingleGoalHistory
// ---------------------------------------------------------------------------

describe('extractSingleGoalHistory', () => {
  it('returns empty array for empty input', () => {
    expect(extractSingleGoalHistory([])).toEqual([]);
  });

  it('concatenates history deltas from multiple results', () => {
    const results: StepResult[] = [
      stepResult({ history: [msg('human', 'hello')] }),
      stepResult({ history: [msg('ai', 'hi there')] }),
    ];
    const history = extractSingleGoalHistory(results);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'human', content: 'hello' });
    expect(history[1]).toEqual({ role: 'ai', content: 'hi there' });
  });

  it('skips results with empty history', () => {
    const results: StepResult[] = [
      stepResult({ history: [msg('human', 'first')] }),
      stepResult({ history: [] }),
      stepResult({ history: [msg('ai', 'second')] }),
    ];
    expect(extractSingleGoalHistory(results)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractAgentMessages
// ---------------------------------------------------------------------------

describe('extractAgentMessages', () => {
  it('returns empty array when no agentResults', () => {
    expect(extractAgentMessages([], 'goal-1')).toEqual([]);
  });

  it('extracts messages for the matching goalId', () => {
    const results: StepResult[] = [
      stepResult({
        agentResults: {
          'goal-1': { goalId: 'goal-1', messages: [msg('ai', 'from goal-1')], status: 'complete' },
          'goal-2': { goalId: 'goal-2', messages: [msg('ai', 'from goal-2')], status: 'complete' },
        },
      }),
    ];
    const messages = extractAgentMessages(results, 'goal-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('from goal-1');
  });

  it('ignores results without the requested goalId', () => {
    const results: StepResult[] = [
      stepResult({
        agentResults: {
          'goal-2': { goalId: 'goal-2', messages: [msg('ai', 'irrelevant')], status: 'complete' },
        },
      }),
    ];
    expect(extractAgentMessages(results, 'goal-1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildConversationHistory
// ---------------------------------------------------------------------------

describe('buildConversationHistory', () => {
  it('returns empty for no results', () => {
    expect(buildConversationHistory([], [])).toEqual([]);
  });

  it('merges orchestrator history with aggregator agent messages', () => {
    const orch: StepResult[] = [
      stepResult({ history: [msg('human', 'plan a trip')] }),
    ];
    const agg: StepResult[] = [
      stepResult({
        agentResults: {
          flight: { goalId: 'flight', messages: [msg('human', 'plan a trip'), msg('ai', 'found flights')], status: 'complete' },
        },
      }),
    ];
    const history = buildConversationHistory(orch, agg);
    expect(history).toEqual([
      msg('human', 'plan a trip'),
      msg('ai', 'found flights'),
    ]);
  });

  it('filters out human messages from agent results to avoid duplication', () => {
    const agg: StepResult[] = [
      stepResult({
        agentResults: {
          hr: { goalId: 'hr', messages: [msg('human', 'duplicate'), msg('ai', 'answer')], status: 'complete' },
        },
      }),
    ];
    const history = buildConversationHistory([], agg);
    expect(history.filter((m) => m.role === 'human')).toHaveLength(0);
    expect(history).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deriveResponse
// ---------------------------------------------------------------------------

describe('deriveResponse', () => {
  it('returns undefined for empty messages', () => {
    expect(deriveResponse([])).toBeUndefined();
  });

  it('returns the last AI message with content', () => {
    const messages: SerializedMessage[] = [
      msg('ai', 'first response'),
      msg('human', 'follow up'),
      msg('ai', 'second response'),
    ];
    expect(deriveResponse(messages)).toBe('second response');
  });

  it('skips AI messages with empty content', () => {
    const messages: SerializedMessage[] = [
      msg('ai', 'has content'),
      msg('ai', '', { toolCalls: [{ id: '1', name: 'tool', args: {} }] }),
    ];
    expect(deriveResponse(messages)).toBe('has content');
  });
});

// ---------------------------------------------------------------------------
// deriveToolCalls
// ---------------------------------------------------------------------------

describe('deriveToolCalls', () => {
  it('returns empty array for no messages', () => {
    expect(deriveToolCalls([], 'g1')).toEqual([]);
  });

  it('returns empty array when no AI message has tool calls', () => {
    expect(deriveToolCalls([msg('ai', 'just text')], 'g1')).toEqual([]);
  });

  it('derives tool calls from the last AI message with toolCalls', () => {
    const messages: SerializedMessage[] = [
      msg('ai', '', {
        toolCalls: [
          { id: 'tc-1', name: 'SearchFlights', args: { origin: 'SFO' } },
          { id: 'tc-2', name: 'BookFlight', args: { flightId: 'UA-1' } },
        ],
      }),
    ];
    const calls = deriveToolCalls(messages, 'flight');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      id: 'tc-1',
      name: 'SearchFlights',
      args: { origin: 'SFO' },
      goalId: 'flight',
    });
    expect(calls[1].goalId).toBe('flight');
  });
});

// ---------------------------------------------------------------------------
// deriveRoutingHistory
// ---------------------------------------------------------------------------

describe('deriveRoutingHistory', () => {
  it('returns empty for empty agentResults', () => {
    expect(deriveRoutingHistory({})).toEqual([]);
  });

  it('builds AI messages prefixed with goalId from agent responses', () => {
    const agentResults: Record<string, AgentChildResult> = {
      flight: { goalId: 'flight', messages: [msg('ai', 'Found 3 flights')], status: 'complete' },
      hr: { goalId: 'hr', messages: [msg('ai', 'You have 15 PTO days')], status: 'complete' },
    };
    const history = deriveRoutingHistory(agentResults);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'ai', content: '[flight] Found 3 flights' });
    expect(history[1]).toEqual({ role: 'ai', content: '[hr] You have 15 PTO days' });
  });

  it('skips agents with no text response', () => {
    const agentResults: Record<string, AgentChildResult> = {
      flight: {
        goalId: 'flight',
        messages: [msg('ai', '', { toolCalls: [{ id: '1', name: 'Search', args: {} }] })],
        status: 'awaiting-confirm',
      },
    };
    expect(deriveRoutingHistory(agentResults)).toEqual([]);
  });
});
