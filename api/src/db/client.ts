import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });

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
