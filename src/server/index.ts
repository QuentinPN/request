import { buildApp, clientDir, dataDir } from './app.ts';
import { openDataDir } from './db/index.ts';

const port = Number(process.env.PORT ?? 3000);
const app = await buildApp({ clientDir, data: openDataDir(dataDir), schedule: true });
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`Request écoute sur le port ${port}`);
