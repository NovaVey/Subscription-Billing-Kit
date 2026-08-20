import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

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
