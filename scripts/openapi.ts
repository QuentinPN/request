// Écrit docs/openapi.json depuis les schémas Zod partagés (`npm run openapi`) ; test/openapi.test.ts vérifie qu'il est à jour.
import { writeFileSync } from 'node:fs';
import { OPENAPI_FILE, openApiJson } from '../src/server/openapi/document.ts';

writeFileSync(OPENAPI_FILE, openApiJson());
console.log(`OpenAPI écrit : ${OPENAPI_FILE}`);
