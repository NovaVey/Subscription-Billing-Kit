import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './mswServer';

// onUnhandledRequest: 'error' means a request nobody registered a handler
// for fails the test loudly instead of silently hitting the real network
// (there is none in this sandbox) or resolving as an opaque failure that's
// hard to trace back to a missing mock.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup(); // unmounts anything rendered by the previous test - without
  // this, two tests in the same file that both render AdminGate (say) both
  // leave their DOM in place, and a query like getByRole throws "found
  // multiple elements" instead of the actual assertion failure.
});
afterAll(() => server.close());
