import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

// A dedicated single-connection pool, not db/client.ts's shared one - the
// `options` startup parameter below (Postgres's own `-c name=value` GUC
// syntax) needs to land on the exact connection drizzle's migrate() runs
// its DDL over, which a shared multi-connection pool used by unrelated
// ordinary queries elsewhere can't guarantee. `max: 1` also matches
// migrate()'s own single-transaction, strictly-serial nature - there's
// nothing for a second connection to do here.
//
// lock_timeout/statement_timeout matter because npm start runs this
// synchronously before the server boots (`node dist/db/migrate.js &&
// node dist/index.js`), and Railway keeps the OUTGOING container - with
// its own live webhook worker/reaper/dunning ticks still running - serving
// traffic until the incoming container's healthcheck passes, which can't
// happen until this finishes. A future migration's locking DDL (an index,
// an ALTER) against a busy table could otherwise contend indefinitely with
// that still-live traffic: with no lock_timeout, Postgres queues the
// blocked statement forever, and every subsequent lock request - including
// the OLD instance's own ordinary reads/writes - queues behind it, stalling
// both instances with nothing to fail fast or alert. A short lock_timeout
// makes a blocked migration fail fast (and loud, via this script's own
// catch below) instead. See the deep bug hunt.
const migrationPool = new Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  max: 1,
  options: '-c lock_timeout=5000 -c statement_timeout=60000',
});
const migrationDb = drizzle(migrationPool);

async function main() {
  await migrate(migrationDb, { migrationsFolder: './src/db/migrations' });
  logger.info('migrations applied');
  await migrationPool.end();
}

main().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
