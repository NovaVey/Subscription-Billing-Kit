import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

export type AdminRole = 'write' | 'read';

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

// crypto.timingSafeEqual throws on mismatched-length buffers, which would
// itself leak key length via a thrown-vs-not-thrown timing difference.
// Hashing both sides to a fixed 32-byte digest first sidesteps that - the
// comparison is now constant-time regardless of the candidate's length.
function safeEqual(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Pure and side-effect-free on purpose (keys passed in, not read from `env`
// here) so unit tests can exercise it without the eager, side-effecting env
// singleton - same reason envSchema.ts is split from env.ts (Phase 0).
export function resolveAdminRole(
  authHeader: string | undefined,
  keys: { writeKey: string; readonlyKey: string },
): AdminRole | null {
  const match = authHeader ? BEARER_PREFIX.exec(authHeader) : null;
  const key = match?.[1];
  if (!key) return null;
  // Both comparisons always run, even after a write-key match, so a
  // request's cost (two safeEqual calls) never signals which key - if any -
  // it matched; only the HTTP response distinguishes that.
  const isWrite = safeEqual(key, keys.writeKey);
  const isRead = safeEqual(key, keys.readonlyKey);
  if (isWrite) return 'write';
  if (isRead) return 'read';
  return null;
}

// Gates every admin route (subscriptions, invoices, dunning, reconciliation,
// webhook-events admin endpoints) - never the public customer/checkout/portal
// routes or the webhook receiver, which are registered outside this scope
// (see app.ts). A read-only key may only GET or HEAD (Fastify registers a
// HEAD sibling for every GET route by default - both are side-effect-free,
// so both are allowed); anything else needs the write key. See
// docs/DECISIONS.md D-033 for why this is a shared-secret gate rather than
// full user accounts.
export async function adminAuthPreHandler(req: FastifyRequest, reply: FastifyReply) {
  const role = resolveAdminRole(req.headers.authorization, {
    writeKey: env.ADMIN_API_KEY,
    readonlyKey: env.ADMIN_READONLY_KEY,
  });
  if (!role) {
    return reply.code(401).send({ error: 'missing or invalid admin credentials' });
  }
  if (role === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
    return reply.code(403).send({ error: 'read-only access - this action requires the write key' });
  }
}
