import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Data, type Db, migrationsFolder, openDataDir } from '../src/server/db/index.ts';
import { SESSION_COOKIE } from '../src/server/plugins/auth.ts';
import { saveArrServer } from '../src/server/services/arr-servers.ts';
import { createSession } from '../src/server/services/sessions.ts';
import { setRole, type User, upsertFromEmby } from '../src/server/services/users.ts';
import { type ArrServerInput, arrKindLabels, arrServerInputSchema } from '../src/shared/arr-servers.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import type { Role } from '../src/shared/roles.ts';
import { SETUP_TOKEN_HEADER } from '../src/shared/setup.ts';
import { type FakeRoutes, startFakeServer } from './fake-server.ts';

/** Crée des dossiers temporaires, supprimés après chaque test du fichier appelant. */
export function trackTempDirs() {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-'));
    dirs.push(dir);
    return dir;
  };
}

/** Crée des applications sur un dossier de données neuf, fermées (et nettoyées) après chaque test. */
export function trackApps() {
  const tempDir = trackTempDirs();
  const apps: FastifyInstance[] = [];
  // Déclaré après trackTempDirs : vitest exécute les afterEach en ordre inverse, les apps ferment avant rmSync.
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });
  return async (options: Pick<Parameters<typeof buildApp>[0], 'upstreams'> = {}) => {
    const app = await buildApp({ data: openDataDir(tempDir()), ...options });
    apps.push(app);
    return app;
  };
}

/** Démarre de faux services (voir fake-server.ts), arrêtés après chaque test. */
export function trackFakeServers() {
  const servers: Array<Awaited<ReturnType<typeof startFakeServer>>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  return async (routes?: FakeRoutes) => {
    const server = await startFakeServer(routes);
    servers.push(server);
    return server;
  };
}

export interface TestSession {
  user: User;
  /** Cookie de session signé et en-tête CSRF : à passer tels quels à `app.inject({ headers })`. */
  headers: Record<string, string>;
}

/**
 * Session d'un membre de ce rôle, sans passer par Emby : le membre est créé en base et le cookie signé
 * comme le ferait la connexion. Un même `id` réutilise le même membre.
 */
export async function loginAs(app: FastifyInstance, role: Role, id = `membre-${role}`): Promise<TestSession> {
  await app.ready();
  const { db } = app.data;
  let user = upsertFromEmby(db, { id, name: `Nom ${id}`, avatar: null, isEmbyAdmin: false });
  if (user.role !== role) user = setRole(db, id, role);
  const { token } = createSession(db, user.id, null);
  return { user, headers: { cookie: `${SESSION_COOKIE}=${app.signCookie(token)}`, ...CSRF_HEADERS } };
}

/** Session du propriétaire (crée le membre propriétaire au besoin). */
export const loginAsOwner = (app: FastifyInstance) => loginAs(app, 'owner', 'proprietaire');

/** En-têtes de l'amorçage sans session : CSRF et jeton d'installation de cette application. */
export const bootstrapHeaders = (app: FastifyInstance): Record<string, string> => ({
  ...CSRF_HEADERS,
  [SETUP_TOKEN_HEADER]: app.setupToken,
});

/**
 * Serveur Radarr/Sonarr écrit en base sans test de connexion (défaut de son couple type/4K s'il est le premier). Nom par
 * défaut « Radarr », « Sonarr 4K »…, clé `k`, profil 1, dossier `/media`.
 */
export const addArrServer = (
  data: Pick<Data, 'db' | 'cryptoKey'>,
  server: Pick<ArrServerInput, 'type' | 'url'> & Partial<ArrServerInput>,
) =>
  saveArrServer(
    data,
    arrServerInputSchema.parse({
      name: `${arrKindLabels[server.type]}${server.is4k ? ' 4K' : ''}`,
      apiKey: 'k',
      qualityProfileId: 1,
      rootFolderPath: '/media',
      ...server,
    }),
  );

/** Plan d'exécution d'une requête Drizzle (même SQL et mêmes paramètres que ceux envoyés à SQLite). */
export function queryPlan(db: Db, query: { toSQL: () => { sql: string; params: unknown[] } }): string {
  const { sql, params } = query.toSQL();
  return (db.$client.prepare(`explain query plan ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((step) => step.detail)
    .join(' | ');
}

/** Copie des migrations tronquée aux `count` premières, dans `parent` : la base telle qu'elle était avant les suivantes. */
export function truncatedMigrations(parent: string, count: number): string {
  const dir = join(parent, 'migrations');
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const { tag } of journal.entries) cpSync(join(migrationsFolder, `${tag}.sql`), join(dir, `${tag}.sql`));
  return dir;
}
