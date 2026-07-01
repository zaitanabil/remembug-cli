import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@devzen/remembug-shared';
import type { Store } from '../../store/index.js';
import { getTool } from './get.js';
import { feedbackTool } from './feedback.js';

function entry(status: Entry['status']): Entry {
  return {
    id: 'e1',
    title: 't',
    problem_body: 'p',
    solution_body: 's',
    tags: [],
    stack: [],
    fingerprint: 'f',
    origin: 'ai_drafted',
    status,
    confirmation_count: 1,
    created_at: 0,
    updated_at: 0,
  };
}

function storeWith(e: Entry | undefined) {
  return {
    getEntry: () => e,
    recordFeedback: vi.fn(() => ({ id: 'fb', entry_id: 'e1', helpful: true, created_at: 0 })),
  } as unknown as Store;
}

describe('getTool', () => {
  it('returns a published entry', () => {
    expect(getTool({ entry_id: 'e1' }, { store: storeWith(entry('published')) })?.id).toBe('e1');
  });
  it('hides a pending_review draft', () => {
    expect(
      getTool({ entry_id: 'e1' }, { store: storeWith(entry('pending_review')) }),
    ).toBeUndefined();
  });
  it('returns undefined for a missing entry', () => {
    expect(getTool({ entry_id: 'x' }, { store: storeWith(undefined) })).toBeUndefined();
  });
});

describe('feedbackTool', () => {
  it('records feedback for a published entry', () => {
    const store = storeWith(entry('published'));
    expect(feedbackTool({ entry_id: 'e1', helpful: true }, { store })).toBeTruthy();
    expect(store.recordFeedback).toHaveBeenCalled();
  });
  it('rejects feedback on a pending_review entry (no confirmation inflation)', () => {
    const store = storeWith(entry('pending_review'));
    expect(() => feedbackTool({ entry_id: 'e1', helpful: true }, { store })).toThrow(/not found/);
    expect(store.recordFeedback).not.toHaveBeenCalled();
  });
  it('rejects feedback on a missing entry', () => {
    expect(() =>
      feedbackTool({ entry_id: 'x', helpful: true }, { store: storeWith(undefined) }),
    ).toThrow();
  });
});
