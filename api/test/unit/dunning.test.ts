import { describe, expect, it } from 'vitest';
import { STAGE_GAP_DAYS, nextActionAtForStage, templateForStage } from '../../src/billing/dunning.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('dunning escalation timing is a fixed, explicit table (§5.10)', () => {
  it('escalates stage 1 to stage 2 after 3 days', () => {
    const enteredStageAt = new Date('2026-01-01T00:00:00.000Z');
    const next = nextActionAtForStage(1, enteredStageAt);
    expect(next.getTime() - enteredStageAt.getTime()).toBe(3 * DAY_MS);
  });

  it('escalates stage 2 to stage 3 after 7 days', () => {
    const enteredStageAt = new Date('2026-01-01T00:00:00.000Z');
    const next = nextActionAtForStage(2, enteredStageAt);
    expect(next.getTime() - enteredStageAt.getTime()).toBe(7 * DAY_MS);
  });

  it('escalates stage 3 to stage 4 after 14 days', () => {
    const enteredStageAt = new Date('2026-01-01T00:00:00.000Z');
    const next = nextActionAtForStage(3, enteredStageAt);
    expect(next.getTime() - enteredStageAt.getTime()).toBe(14 * DAY_MS);
  });

  it('gaps are measured from the stage just entered, not cumulatively from the cycle open (see docs/DECISIONS.md)', () => {
    expect(STAGE_GAP_DAYS[1]).toBe(3);
    expect(STAGE_GAP_DAYS[2]).toBe(7);
    expect(STAGE_GAP_DAYS[3]).toBe(14);
  });

  it('assigns a distinct, stable template per stage so notices never collide across stages', () => {
    const templates = [1, 2, 3].map((stage) => templateForStage(stage as 1 | 2 | 3));
    expect(new Set(templates).size).toBe(3);
    expect(templateForStage(1)).toBe(templateForStage(1));
  });
});
