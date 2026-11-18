import { buildApp, clientDir, dataDir } from './app.ts';
import { openDataDir } from './db/index.ts';
import { announceSetupToken } from './plugins/auth.ts';

const port = Number(process.env.PORT ?? 3000);
const app = await buildApp({ clientDir, data: openDataDir(dataDir), schedule: true });
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`Request écoute sur le port ${port}`);
announceSetupToken(app);

// `docker stop` envoie SIGTERM : fermer proprement (balayage en cours terminé, base SQLite fermée) plutôt que d'être tué.
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
