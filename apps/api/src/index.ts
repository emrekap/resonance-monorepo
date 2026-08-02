import app from './app';

const port = Number(process.env.PORT ?? 3000);

// eslint-disable-next-line no-console
console.log(`🚀 resonance-api listening on http://localhost:${port}`);

// Bun serves a default export of { port, fetch }.
export default {
  port,
  fetch: app.fetch,
};