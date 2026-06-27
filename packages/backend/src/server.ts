import { buildApp } from './app.js';
import { config } from './platform/config.js';

async function main() {
  const app = await buildApp();

  await app.listen({
    port: config.port,
    host: '0.0.0.0', // Railway 要求绑 0.0.0.0
  });

  console.log(`Backend running on port ${config.port}`);

  // Graceful shutdown: close Fastify (stop accepting + drain in-flight) then exit 0 on stop signals.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
