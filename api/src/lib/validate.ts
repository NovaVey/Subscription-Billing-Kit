import type { FastifyReply } from 'fastify';
import { z } from 'zod';

// Parses `data` against `schema` and, on failure, sends the route's
// standard 400 response and returns undefined - callers do:
//   const body = parseOrReply(Schema, req.body, reply);
//   if (!body) return;
// A single shared home for the safeParse -> 400 block that was previously
// duplicated verbatim across 11 route handlers. See the /improve audit.
export function parseOrReply<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | undefined {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

// z.uuid() (RFC 9562/4122) rejects a syntactically-fine placeholder like
// "00000000-0000-0000-0000-000000000099" - its version nibble (the '0' in
// the 3rd group) isn't 1-8, so it fails RFC validity even though it's
// exactly the harmless kind of fixture id tests (and Postgres's own uuid
// column type, which has no opinion on version/variant bits) accept
// without complaint. z.guid() checks only the 8-4-4-4-12 hex shape, no
// version/variant constraint - the actual thing worth rejecting here is
// "not shaped like a uuid at all" (Postgres's own failure mode), not "a
// syntactically valid but RFC-atypical uuid".
const UuidParam = z.object({ id: z.guid() });

// Validates a route's `:id` path param as UUID-shaped before it's ever
// used in a DB equality filter against a uuid column - callers do:
//   const id = parseUuidParam(req, reply);
//   if (!id) return;
// `:id` params in this codebase are always a `subscriptions.id` or
// `reconciliation_runs.id`, both uuid columns (never a Stripe-prefixed id
// like `evt_...` - see routes/webhookEvents.ts, which stays on the plain
// `{ id: string }` cast since its :id is a Stripe event id, not a uuid).
// Without this check, a malformed id makes Postgres throw `invalid input
// syntax for type uuid`, and with no per-route try/catch that propagates
// straight to Fastify's fallback error handler, which serializes the raw
// driver error text into a 500 - leaking column/type/driver details to
// anyone holding an admin key instead of a clean 400. See the deep bug
// hunt.
export function parseUuidParam(req: { params: unknown }, reply: FastifyReply): string | undefined {
  const parsed = UuidParam.safeParse(req.params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid id - must be a UUID' });
    return undefined;
  }
  return parsed.data.id;
}
