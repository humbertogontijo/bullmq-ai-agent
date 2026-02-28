import { describe, it, expect } from 'vitest';
import {
  buildAgentSystemMessage,
  buildOrchestratorSystemMessage,
  formatHistoryForOrchestrator,
} from '../src/prompts.js';
import type { AgentGoal, SerializedMessage } from '../src/types.js';

function makeGoal(overrides?: Partial<AgentGoal>): AgentGoal {
  return {
    id: 'test-goal',
    agentName: 'Test Agent',
    agentFriendlyDescription: 'A test agent',
    description: 'Help the user with testing.',
    tools: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAgentSystemMessage
// ---------------------------------------------------------------------------

describe('buildAgentSystemMessage', () => {
  it('includes the goal description', () => {
    const msg = buildAgentSystemMessage(makeGoal(), false);
    expect(msg).toContain('Help the user with testing.');
  });

  it('includes custom systemMessage when provided', () => {
    const msg = buildAgentSystemMessage(
      makeGoal({ systemMessage: 'Always be polite.' }),
      false,
    );
    expect(msg).toContain('Always be polite.');
  });

  it('does not include multi-agent section in single mode', () => {
    const msg = buildAgentSystemMessage(makeGoal(), false);
    expect(msg).not.toContain('Multi-Agent Mode');
  });

  it('includes multi-agent section when enabled', () => {
    const msg = buildAgentSystemMessage(makeGoal(), true);
    expect(msg).toContain('Multi-Agent Mode');
    expect(msg).toContain('specialist agents');
  });

  it('includes the current date', () => {
    const msg = buildAgentSystemMessage(makeGoal(), false);
    const year = new Date().getFullYear().toString();
    expect(msg).toContain(year);
  });
});

// ---------------------------------------------------------------------------
// buildOrchestratorSystemMessage
// ---------------------------------------------------------------------------

describe('buildOrchestratorSystemMessage', () => {
  it('lists all agent descriptions', () => {
    const goals = [
      makeGoal({ id: 'flight', agentName: 'Flight', agentFriendlyDescription: 'Book flights' }),
      makeGoal({ id: 'hr', agentName: 'HR', agentFriendlyDescription: 'Manage PTO' }),
    ];
    const msg = buildOrchestratorSystemMessage(goals);
    expect(msg).toContain('"flight"');
    expect(msg).toContain('"hr"');
    expect(msg).toContain('Book flights');
    expect(msg).toContain('Manage PTO');
  });

  it('instructs to return a JSON array', () => {
    const msg = buildOrchestratorSystemMessage([makeGoal()]);
    expect(msg).toContain('JSON array');
  });
});

// ---------------------------------------------------------------------------
// formatHistoryForOrchestrator
// ---------------------------------------------------------------------------

describe('formatHistoryForOrchestrator', () => {
  it('returns empty string for empty history', () => {
    expect(formatHistoryForOrchestrator([])).toBe('');
  });

  it('returns empty string when no human/ai messages', () => {
    const history: SerializedMessage[] = [
      { role: 'tool', content: 'tool result' },
      { role: 'system', content: 'system' },
    ];
    expect(formatHistoryForOrchestrator(history)).toBe('');
  });

  it('formats human and ai messages', () => {
    const history: SerializedMessage[] = [
      { role: 'human', content: 'Find flights' },
      { role: 'ai', content: 'Found 3 options' },
    ];
    const result = formatHistoryForOrchestrator(history);
    expect(result).toContain('User: Find flights');
    expect(result).toContain('Agent: Found 3 options');
    expect(result).toContain('Recent Conversation');
  });

  it('truncates long messages to 200 characters', () => {
    const longContent = 'x'.repeat(300);
    const history: SerializedMessage[] = [
      { role: 'ai', content: longContent },
    ];
    const result = formatHistoryForOrchestrator(history);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longContent.length + 100);
  });
});
