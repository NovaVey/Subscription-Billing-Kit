import { env } from './env.js';
import { buildApp } from './app.js';
import { startWebhookWorker } from './webhooks/worker.js';
import { resolveListenTarget } from './lib/listenTarget.js';

const { port, host } = resolveListenTarget(env.API_BASE_URL);

const app = buildApp();

app
  .listen({ port, host })
  .then((address) => {
    app.log.info({ address, apiVersion: env.STRIPE_API_VERSION }, 'billing-kit api listening');
    startWebhookWorker();
  })
  .catch((err) => {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  });
