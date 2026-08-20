import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// worker.ts's own interval wiring has no coverage anywhere: whether stop()
// actually clears every timer, and whether the dunning timer is correctly
// omitted when DUNNING_ENABLED=false. The processor/reaper/dunning modules
// are mocked out entirely so this never touches a real Postgres pool - a
// pure control-flow test, hence living in test/unit rather than
// test/integration. See the /improve audit.

const mockProcessPendingWebhookEvents = vi.fn().mockResolvedValue({ claimed: 0 });
const mockReapStaleProcessingEvents = vi.fn().mockResolvedValue({ reaped: 0 });
const mockRunDunningTick = vi.fn().mockResolvedValue({ escalated: 0, sent: 0, failed: 0 });

vi.mock('../../src/webhooks/processor.js', () => ({
  processPendingWebhookEvents: (...args: unknown[]) => mockProcessPendingWebhookEvents(...args),
}));
vi.mock('../../src/webhooks/reaper.js', () => ({
  reapStaleProcessingEvents: (...args: unknown[]) => mockReapStaleProcessingEvents(...args),
}));
vi.mock('../../src/billing/dunning.js', () => ({
  runDunningTick: (...args: unknown[]) => mockRunDunningTick(...args),
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  mockProcessPendingWebhookEvents.mockClear();
  mockReapStaleProcessingEvents.mockClear();
  mockRunDunningTick.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('startWebhookWorker interval wiring', () => {
  it('omits the dunning timer when DUNNING_ENABLED is false, and stop() clears every timer', async () => {
    vi.doMock('../../src/env.js', () => ({ env: { DUNNING_ENABLED: false } }));
    const { startWebhookWorker } = await import('../../src/webhooks/worker.js');

    const { stop } = startWebhookWorker();

    // Past every interval at least once (processor 2s, reaper 30s, dunning 15min).
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(mockProcessPendingWebhookEvents).toHaveBeenCalled();
    expect(mockReapStaleProcessingEvents).toHaveBeenCalled();
    expect(mockRunDunningTick).not.toHaveBeenCalled();

    stop();
    mockProcessPendingWebhookEvents.mockClear();
    mockReapStaleProcessingEvents.mockClear();
    mockRunDunningTick.mockClear();

    // No further ticks fire on any timer after stop().
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockProcessPendingWebhookEvents).not.toHaveBeenCalled();
    expect(mockReapStaleProcessingEvents).not.toHaveBeenCalled();
    expect(mockRunDunningTick).not.toHaveBeenCalled();
  });

  it('schedules the dunning timer when DUNNING_ENABLED is true', async () => {
    vi.doMock('../../src/env.js', () => ({ env: { DUNNING_ENABLED: true } }));
    const { startWebhookWorker } = await import('../../src/webhooks/worker.js');

    const { stop } = startWebhookWorker();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(mockRunDunningTick).toHaveBeenCalled();

    stop();
  });
});
