import { logger } from '../lib/logger.js';

// Dunning notices go through this interface rather than calling a provider
// directly (§5.10/§5.12), so a real provider (Postmark, SES, Resend, ...)
// swaps in without touching billing/dunning.ts. The console implementation
// is the default because this kit's job stops at deciding *when* to notify
// and recording that it happened - actually delivering email is the
// integrating product's concern, same as feature-gating on dunning stage.
export interface DunningNoticeInput {
  subscriptionId: string;
  stage: number;
  template: string;
  payload: Record<string, unknown>;
}

export interface EmailAdapter {
  send(input: DunningNoticeInput): Promise<void>;
}

export class ConsoleEmailAdapter implements EmailAdapter {
  async send(input: DunningNoticeInput): Promise<void> {
    logger.info(
      { subscriptionId: input.subscriptionId, stage: input.stage, template: input.template, payload: input.payload },
      'dunning notice (console adapter - no real email sent)',
    );
  }
}

export const emailAdapter: EmailAdapter = new ConsoleEmailAdapter();
