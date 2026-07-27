import { logger } from '../lib/logger.js';
import { processPendingWebhookEvents } from './processor.js';
import { reapStaleProcessingEvents } from './reaper.js';

// Runs the webhook processor and reaper as in-process interval loops
// (§0 rule 5's Postgres-as-queue design, D-005, doesn't call for a
// separate worker service — SKIP LOCKED already makes it safe to run
// this alongside the HTTP server in the same process).
const PROCESSOR_INTERVAL_MS = 2_000;
const REAPER_INTERVAL_MS = 30_000;

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

  processorTimer.unref();
  reaperTimer.unref();

  return {
    stop: () => {
      clearInterval(processorTimer);
      clearInterval(reaperTimer);
    },
  };
}
