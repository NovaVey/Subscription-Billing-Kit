import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema.js';

// connectionTimeoutMillis is required, not cosmetic: without it, a Postgres
// that's down or unreachable hangs any caller of checkDbConnectivity() (and
// therefore /health) on the OS-level TCP timeout — minutes, not seconds.
export const pool = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 });

// node-postgres emits 'error' on the pool when an already-connected, idle
// client hits a connection-level problem (the backend restarting, the
// network dropping, an admin killing the connection). Node's EventEmitter
// treats an unhandled 'error' event as fatal and crashes the whole process
// — so a DB restart would take down every in-flight request, not just fail
// the one that happened to be querying at that moment. This handler is what
// turns "the database bounced" into "some requests got a 500" instead of
// "the process is gone."
pool.on('error', (err) => {
  logger.error({ err }, 'idle Postgres client emitted an error');
});

export const db = drizzle(pool, { schema });

// Accepts either the top-level db or a transaction handle from
// db.transaction(async (tx) => ...) — derived from db's own type so it
// always matches the actual generic instantiation, rather than guessing it.
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DbConnectivity {
  ok: boolean;
  error?: string;
}

export async function checkDbConnectivity(): Promise<DbConnectivity> {
  try {
    await pool.query('select 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
