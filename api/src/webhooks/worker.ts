import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { runDunningTick } from '../billing/dunning.js';
import { processPendingWebhookEvents } from './processor.js';
import { reapStaleProcessingEvents } from './reaper.js';

// Runs the webhook processor and reaper as in-process interval loops
// (§0 rule 5's Postgres-as-queue design, D-005, doesn't call for a
// separate worker service — SKIP LOCKED already makes it safe to run
// this alongside the HTTP server in the same process).
const PROCESSOR_INTERVAL_MS = 2_000;
const REAPER_INTERVAL_MS = 30_000;
// "every 15 min in dev, cron in prod" (§5.12) - this interval covers dev;
// scripts/dunning-tick.ts is the one-shot entry point a prod cron invokes
// instead of relying on a long-lived process's timer surviving restarts.
const DUNNING_TICK_INTERVAL_MS = 15 * 60_000;

export function startWebhookWorker(): { stop: () => void } {
  const processorTimer = setInterval(() => {
    processPendingWebhookEvents().catch((err) => {
      logger.error({ err }, 'webhook processor tick failed');
    });
  }, PROCESSOR_INTERVAL_MS);

  const reaperTimer = setInterval(() => {
    reapStaleProcessingEvents().catch((err) => {
      logger.error({ err }, 'webhook reaper tick failed');
    });
  }, REAPER_INTERVAL_MS);

  // Feature-flagged (§0 rule 5's env vars): disabling dunning pauses
  // escalation and notifications, but webhook handlers still record cycle
  // open/resolve/close state regardless - see docs/ARCHITECTURE.md.
  const dunningTimer = env.DUNNING_ENABLED
    ? setInterval(() => {
        runDunningTick().catch((err) => {
          logger.error({ err }, 'dunning tick failed');
        });
      }, DUNNING_TICK_INTERVAL_MS)
    : null;

  processorTimer.unref();
  reaperTimer.unref();
  dunningTimer?.unref();

  return {
    stop: () => {
      clearInterval(processorTimer);
      clearInterval(reaperTimer);
      if (dunningTimer) clearInterval(dunningTimer);
    },
  };
}
