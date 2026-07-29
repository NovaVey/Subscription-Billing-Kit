import { env } from '../../../src/env.js';

// Every admin route (Phase 10) rejects requests with no valid key, so any
// integration test hitting one needs this header. Read from env rather than
// hard-coded so it always matches whatever ADMIN_API_KEY/ADMIN_READONLY_KEY
// this test run actually booted with (.env locally, CI's placeholder in
// ci.yml).
export const WRITE_KEY_HEADERS = { authorization: `Bearer ${env.ADMIN_API_KEY}` };
export const READONLY_KEY_HEADERS = { authorization: `Bearer ${env.ADMIN_READONLY_KEY}` };
