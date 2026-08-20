import { setupServer } from 'msw/node';

// A single shared MSW server instance - test/setup.ts manages its
// listen/reset/close lifecycle around every test file; individual test
// files import this and call server.use(...) to register the handlers
// their scenario needs.
export const server = setupServer();
