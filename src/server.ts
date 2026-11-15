import { startupReport } from './startup-errors.js';
import { buildApp } from './app.js';
try {
  const app = await buildApp();
  await app.listen({
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
  });
  console.log(`Backend disponible en ${app.server.address() && app.listeningOrigin}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void app.close();
    });
} catch (error) {
  process.stderr.write(JSON.stringify(startupReport(error)) + '\n', () => {
    process.exit(1);
  });
}
