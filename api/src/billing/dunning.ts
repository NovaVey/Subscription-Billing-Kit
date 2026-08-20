import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { dunningNotices, dunningState } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { emailAdapter } from './emailAdapter.js';

// Escalation stage machine (§5.10). Keyed by the stage a subscription is
// CURRENTLY in - the value is how many days of no resolution before it
// escalates to the next stage. Stage 4 is terminal: nothing escalates it
// further, only `invoice.paid` (recovered) or `customer.subscription.deleted`
// (canceled) ever moves a cycle off of it.
//
// dunning_state has a single, mutable `entered_stage_at` column rather than
// a separate "cycle opened at" timestamp, which is the textual evidence for
// reading these gaps as relative to the *previous* stage's entry, not
// cumulative from the cycle's original open - see docs/DECISIONS.md.
export const STAGE_GAP_DAYS: Readonly<Record<1 | 2 | 3, number>> = { 1: 3, 2: 7, 3: 14 };
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// Exported for unit testing (§9's pattern of isolating pure logic from the
// DB-touching functions around it, as with billing/stateMachine.ts).
export function nextActionAtForStage(stage: 1 | 2 | 3, enteredStageAt: Date): Date {
  return addDays(enteredStageAt, STAGE_GAP_DAYS[stage]);
}

export function templateForStage(stage: 1 | 2 | 3): string {
  return {
    1: 'dunning_stage_1_payment_failed',
    2: 'dunning_stage_2_reminder',
    3: 'dunning_stage_3_final_notice',
  }[stage];
}

// Writes (or re-arms) the dunning_notices row for a stage, but never
// touches `sent_at`/`queued_at` on an existing row unless the caller
// already knows any existing row must be stale (`resetIfStale`). This is
// what keeps a crash between this write and the actual send from ever
// producing two emails for the same stage of the same cycle - see
// sendUnsentDunningNotices() below, and docs/ARCHITECTURE.md.
async function armNotice(
  tx: Executor,
  input: { subscriptionId: string; stage: 1 | 2 | 3; resetIfStale: boolean },
): Promise<void> {
  const template = templateForStage(input.stage);
  const payload = { subscriptionId: input.subscriptionId, stage: input.stage };
  if (input.resetIfStale) {
    await tx
      .insert(dunningNotices)
      .values({ subscriptionId: input.subscriptionId, stage: input.stage, channel: 'email', template, payload })
      .onConflictDoUpdate({
        target: [dunningNotices.subscriptionId, dunningNotices.stage],
        set: { template, payload, queuedAt: new Date(), sentAt: null, sendError: null },
      });
  } else {
    await tx
      .insert(dunningNotices)
      .values({ subscriptionId: input.subscriptionId, stage: input.stage, channel: 'email', template, payload })
      .onConflictDoNothing({ target: [dunningNotices.subscriptionId, dunningNotices.stage] });
  }
}

// Opens a dunning cycle on the first `invoice.payment_failed` for a
// subscription invoice, or re-opens one after a prior cycle fully
// resolved. If a cycle is already open, this is a no-op: Stripe Smart
// Retries owns re-charging (§5.10), so repeated failed-attempt events on
// an already-dunning subscription don't restart the clock.
export async function openDunningCycleOnPaymentFailed(
  tx: Executor,
  input: { subscriptionId: string; invoiceId: string; now: Date },
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(dunningState)
    .where(eq(dunningState.subscriptionId, input.subscriptionId));

  if (existing && existing.resolvedAt === null) {
    return;
  }

  const nextActionAt = nextActionAtForStage(1, input.now);
  if (existing) {
    await tx
      .update(dunningState)
      .set({
        triggeringInvoiceId: input.invoiceId,
        stage: 1,
        enteredStageAt: input.now,
        nextActionAt,
        lastNoticeAt: null,
        noticesSent: 0,
        resolvedAt: null,
        resolution: null,
      })
      .where(eq(dunningState.subscriptionId, input.subscriptionId));

    // dunning_notices' uniqueness is scoped to (subscriptionId, stage) only,
    // not to a cycle - a stage 2/3 row this subscription's PRIOR (now
    // resolved) cycle already sent would otherwise still be sitting here
    // with sent_at set. Left in place, escalateDueCycles()'s later
    // armNotice(..., resetIfStale:false) call for this new cycle would hit
    // that row's conflict and silently no-op, so the new cycle's stage 2/3
    // notice would never be armed or sent even though dunning_state.stage
    // correctly advances. Clearing every notice row for this subscription
    // when a cycle re-opens guarantees the new cycle starts with a clean
    // slate to arm against.
    await tx.delete(dunningNotices).where(eq(dunningNotices.subscriptionId, input.subscriptionId));
  } else {
    await tx.insert(dunningState).values({
      subscriptionId: input.subscriptionId,
      triggeringInvoiceId: input.invoiceId,
      stage: 1,
      enteredStageAt: input.now,
      nextActionAt,
    });
  }

  // Opening a cycle is only reached when we already know no cycle is
  // currently open (checked above), and the branch above just cleared any
  // leftover notice rows on a re-open - so armNotice's own conflict target
  // is guaranteed empty here either way. resetIfStale:true is kept as
  // defense in depth, not as the thing doing the work.
  await armNotice(tx, { subscriptionId: input.subscriptionId, stage: 1, resetIfStale: true });
}

// Resolution is keyed to the *specific* invoice that opened the cycle, not
// to the subscription or customer (§5.10) - a customer with two
// subscriptions, or a paid one-off invoice, must not clear a cycle it has
// nothing to do with.
export async function resolveDunningOnInvoicePaid(
  tx: Executor,
  input: { invoiceId: string; now: Date },
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(dunningState)
    .where(and(eq(dunningState.triggeringInvoiceId, input.invoiceId), isNull(dunningState.resolvedAt)));

  if (!existing) return;

  await tx
    .update(dunningState)
    .set({ resolvedAt: input.now, resolution: 'recovered', stage: 0, nextActionAt: null })
    .where(eq(dunningState.subscriptionId, existing.subscriptionId));
}

// A deleted subscription has nothing left to collect on - closes any open
// cycle as 'canceled' rather than leaving it open-but-terminal, which is
// what a pure timeout escalation to stage 4 does (see escalateDueCycles).
export async function closeDunningOnSubscriptionDeleted(
  tx: Executor,
  input: { subscriptionId: string; now: Date },
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(dunningState)
    .where(and(eq(dunningState.subscriptionId, input.subscriptionId), isNull(dunningState.resolvedAt)));

  if (!existing) return;

  await tx
    .update(dunningState)
    .set({
      stage: 4,
      enteredStageAt: input.now,
      nextActionAt: null,
      resolvedAt: input.now,
      resolution: 'canceled',
    })
    .where(eq(dunningState.subscriptionId, input.subscriptionId));
}

// Escalates every cycle whose current stage's grace period has elapsed.
// Grouped by fromStage - only ever 1, 2, or 3 - into one bulk UPDATE per
// group instead of one transaction per row: the same optimistic
// `where stage = fromStage` guard (a row already escalated by a concurrent
// tick is skipped rather than double-escalated) applies just as well across
// a whole IN-list as it does to a single row. The claimed rows' notices are
// then armed with one batched multi-row insert. Notices are only *armed*
// here (sent_at left null) - actually sending is sendUnsentDunningNotices()'s
// job, run every tick after this pass, so a crash between the two can only
// ever leave a notice unsent, never resend one already confirmed sent. See
// the /improve audit for why this used to be one transaction per row.
async function escalateDueCycles(now: Date): Promise<number> {
  const due = await db
    .select()
    .from(dunningState)
    .where(
      and(
        gte(dunningState.stage, 1),
        lte(dunningState.stage, 3),
        isNull(dunningState.resolvedAt),
        lte(dunningState.nextActionAt, now),
      ),
    );

  let escalated = 0;

  for (const fromStage of [1, 2, 3] as const) {
    const rowsForStage = due.filter((row) => row.stage === fromStage);
    if (rowsForStage.length === 0) continue;

    const toStage = (fromStage + 1) as 2 | 3 | 4;
    const ids = rowsForStage.map((row) => row.subscriptionId);

    const claimedCount = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(dunningState)
        .set({
          stage: toStage,
          enteredStageAt: now,
          nextActionAt: toStage < 4 ? nextActionAtForStage(toStage as 1 | 2 | 3, now) : null,
        })
        .where(and(inArray(dunningState.subscriptionId, ids), eq(dunningState.stage, fromStage)))
        .returning({ subscriptionId: dunningState.subscriptionId });

      // toStage === 4 ("access revoked, marked terminal", §5.10) sends no
      // further notice - the table describes an access change at stage 4,
      // not a communication, unlike stages 1-3.
      if (claimed.length > 0 && toStage <= 3) {
        const stage = toStage as 1 | 2 | 3;
        const template = templateForStage(stage);
        await tx
          .insert(dunningNotices)
          .values(
            claimed.map((row) => ({
              subscriptionId: row.subscriptionId,
              stage,
              channel: 'email',
              template,
              payload: { subscriptionId: row.subscriptionId, stage },
            })),
          )
          .onConflictDoNothing({ target: [dunningNotices.subscriptionId, dunningNotices.stage] });
      }

      return claimed.length;
    });

    escalated += claimedCount;
  }

  return escalated;
}

// Sends every armed-but-unsent notice, system-wide - not just ones armed
// by this tick's own escalation pass. This is deliberate: it is the only
// thing that can retry a notice stranded by a crash between a previous
// tick's escalation transaction (which commits sent_at = null) and the
// send confirming. Checking `sent_at is null` immediately before sending,
// and writing sent_at right after, is what makes replaying this safe -
// two ticks racing on the same row can both attempt the send, but only the
// one whose write lands first (this function runs single-threaded via the
// in-process interval, so in practice there is no race here at all, only
// crash recovery across ticks).
async function sendUnsentDunningNotices(): Promise<{ sent: number; failed: number }> {
  // A notice can be armed (sent_at left null) in the same window a
  // concurrent invoice.paid resolves its cycle - armNotice() and
  // resolveDunningOnInvoicePaid() are separate transactions, not atomic
  // with each other. Joining against dunning_state and requiring
  // resolved_at IS NULL here means a notice for an already-resolved cycle
  // is never sent, even if it was armed moments before resolution landed.
  const unsent = await db
    .select({
      id: dunningNotices.id,
      subscriptionId: dunningNotices.subscriptionId,
      stage: dunningNotices.stage,
      template: dunningNotices.template,
      payload: dunningNotices.payload,
    })
    .from(dunningNotices)
    .innerJoin(dunningState, eq(dunningState.subscriptionId, dunningNotices.subscriptionId))
    .where(and(isNull(dunningNotices.sentAt), isNull(dunningState.resolvedAt)));

  let sent = 0;
  let failed = 0;
  for (const notice of unsent) {
    try {
      await emailAdapter.send({
        subscriptionId: notice.subscriptionId,
        stage: notice.stage,
        template: notice.template,
        payload: notice.payload ?? {},
      });
      const sentAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(dunningNotices)
          .set({ sentAt, sendError: null })
          .where(eq(dunningNotices.id, notice.id));
        await tx
          .update(dunningState)
          .set({ lastNoticeAt: sentAt, noticesSent: sql`${dunningState.noticesSent} + 1` })
          .where(eq(dunningState.subscriptionId, notice.subscriptionId));
      });
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(dunningNotices).set({ sendError: message }).where(eq(dunningNotices.id, notice.id));
      logger.error(
        { err, subscriptionId: notice.subscriptionId, stage: notice.stage },
        'dunning notice send failed',
      );
      failed++;
    }
  }
  return { sent, failed };
}

export async function runDunningTick(
  now: Date = new Date(),
): Promise<{ escalated: number; sent: number; failed: number }> {
  const escalated = await escalateDueCycles(now);
  const { sent, failed } = await sendUnsentDunningNotices();
  return { escalated, sent, failed };
}
