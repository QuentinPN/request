import { buildApp, clientDir } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const app = await buildApp({ clientDir });
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`Request écoute sur le port ${port}`);
