import { env } from './env.js';
import { buildApp } from './app.js';

const listenUrl = new URL(env.API_BASE_URL);
const port = listenUrl.port ? Number(listenUrl.port) : 3000;
const host = listenUrl.hostname === 'localhost' ? '0.0.0.0' : listenUrl.hostname;

const app = buildApp();

app
  .listen({ port, host })
  .then((address) => {
    app.log.info({ address, apiVersion: env.STRIPE_API_VERSION }, 'billing-kit api listening');
  })
  .catch((err) => {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  });
