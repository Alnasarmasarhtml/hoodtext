/**
 * Relay entry point.
 *
 * Boots the server built by {@link buildServer} and binds the port. Everything
 * interesting lives in `server.ts`; this file only owns process concerns —
 * listening, signals, and a non-zero exit when startup fails.
 */

import { buildServer } from './server.js';

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

async function main(): Promise<void> {
  const app = await buildServer();
  const { port, host, dbPath } = app.relayConfig;

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'relay: shutting down');
    app.close().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        app.log.error({ err: error }, 'relay: shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port, host });
  app.log.info({ port, host, dbPath }, 'relay: ready');
}

main().catch((error: unknown) => {
  // No logger exists if the failure happened before the server was built.
  process.stderr.write(`relay failed to start: ${describe(error)}\n`);
  process.exitCode = 1;
});
