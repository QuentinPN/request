import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPENAPI_FILE, openApiJson, toOpenApiPath } from '../src/server/openapi/document.ts';
import { OPERATIONS } from '../src/server/openapi/operations.ts';
import { appWithApiRoutes, trackApps } from './helpers.ts';

const newApp = trackApps();

const registeredRoutes = async () => (await appWithApiRoutes(newApp)).routes;

const documented = new Set(OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`));

/** Zones que le document couvre : toute route de ces préfixes (au segment près) est documentée ou exclue ci-dessous. */
const COVERED_PREFIXES = [
  '/api/health',
  '/api/version',
  '/api/auth',
  '/api/discover',
  '/api/genres',
  '/api/providers',
  '/api/search',
  '/api/person',
  '/api/collection',
  '/api/media',
  '/api/images',
  '/api/requests',
  '/api/watchlist',
  '/api/notifications',
  '/api/account/notifications',
  '/api/users/:id/avatar',
];

/** Routes des zones couvertes volontairement absentes du document, avec leur raison. */
const EXCLUDED: Record<string, string> = {
  'POST /api/auth/plex/pin': 'connexion Plex du navigateur (cookie du code PIN)',
  'POST /api/auth/plex/pin/check': 'connexion Plex du navigateur (cookie du code PIN)',
  'GET /api/requests/send-options/:type': 'gestion des demandes',
  'POST /api/requests/:id/approve': 'gestion des demandes',
  'POST /api/requests/:id/decline': 'gestion des demandes',
  'POST /api/requests/:id/retry': 'gestion des demandes',
  'POST /api/requests/batch': 'gestion des demandes',
};

const inCoveredZone = (route: string) => {
  const path = route.slice(route.indexOf(' ') + 1);
  return COVERED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

describe('document OpenAPI', () => {
  it('docs/openapi.json est à jour', () => {
    const committed = readFileSync(OPENAPI_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === openApiJson(), 'docs/openapi.json n’est plus à jour : lancer npm run openapi').toBe(true);
  });

  it('chaque opération documentée existe dans Fastify', async () => {
    const routes = await registeredRoutes();
    expect([...documented].filter((route) => !routes.has(route))).toEqual([]);
  });

  it('chaque route des zones couvertes est documentée ou explicitement exclue', async () => {
    const routes = await registeredRoutes();
    const missing = [...routes].filter((route) => inCoveredZone(route) && !documented.has(route) && !EXCLUDED[route]);
    expect(missing, 'route sans documentation : l’ajouter à OPERATIONS (src/server/openapi/operations.ts)').toEqual([]);
    // Une exclusion qui ne correspond plus à aucune route est à retirer.
    expect(Object.keys(EXCLUDED).filter((route) => !routes.has(route))).toEqual([]);
  });

  it('est un OpenAPI 3.1 structurellement valide, tous ses $ref résolus', () => {
    const doc = JSON.parse(openApiJson());
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(typeof doc.info?.title).toBe('string');
    expect(doc.info?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    const schemes = new Set(Object.keys(doc.components.securitySchemes));
    const checkSecurity = (security: Array<Record<string, unknown>>) => {
      for (const requirement of security) for (const name of Object.keys(requirement)) expect(schemes).toContain(name);
    };
    checkSecurity(doc.security);

    const tags = new Set(doc.tags.map((tag: { name: string }) => tag.name));
    const operationIds = new Set<string>();
    for (const [path, item] of Object.entries<Record<string, Record<string, unknown>>>(doc.paths)) {
      expect(path.startsWith('/')).toBe(true);
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const [method, op] of Object.entries(item)) {
        expect(['get', 'put', 'post', 'delete', 'patch']).toContain(method);
        const id = op.operationId as string;
        expect(operationIds.has(id), `operationId en double : ${id}`).toBe(false);
        operationIds.add(id);
        for (const tag of op.tags as string[]) expect(tags).toContain(tag);
        if (op.security) checkSecurity(op.security as Array<Record<string, unknown>>);
        const params = (op.parameters ?? []) as Array<{ name: string; in: string; required: boolean; schema: unknown }>;
        for (const p of params) {
          expect(['path', 'query']).toContain(p.in);
          expect(p.schema).toBeTypeOf('object');
        }
        const inPath = params.filter((p) => p.in === 'path');
        expect(inPath.every((p) => p.required)).toBe(true);
        expect(inPath.map((p) => p.name).sort(), `${method} ${path}`).toEqual(templated);
        const responses = Object.entries(op.responses as Record<string, { description?: unknown }>);
        expect(responses.length).toBeGreaterThan(0);
        for (const [code, response] of responses) {
          expect(code).toMatch(/^[1-5]\d\d$/);
          expect(typeof response.description).toBe('string');
        }
      }
    }

    // Chaque `$ref` désigne un composant existant ; aucun `$ref` local de Zod (`#/$defs/…`) ne reste.
    const refs: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) key === '$ref' ? refs.push(item as string) : walk(item);
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
      expect(name && name in doc.components.schemas, `$ref non résolu : ${ref}`).toBe(true);
    }
    expect(JSON.stringify(doc)).not.toMatch(/"\$(schema|id|defs)"/);
  });

  it('convertit les paramètres Fastify en paramètres OpenAPI', () => {
    expect(toOpenApiPath('/api/media/:type/:id')).toBe('/api/media/{type}/{id}');
  });
});
