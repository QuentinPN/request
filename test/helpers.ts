import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Data, type Db, migrationsFolder, openDataDir } from '../src/server/db/index.ts';
import { users } from '../src/server/db/schema.ts';
import { SESSION_COOKIE } from '../src/server/plugins/auth.ts';
import { saveArrServer } from '../src/server/services/arr-servers.ts';
import { createSession } from '../src/server/services/sessions.ts';
import { type User, upsertFromEmby } from '../src/server/services/users.ts';
import { type ArrServerInput, arrKindLabels, arrServerInputSchema } from '../src/shared/arr-servers.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import type { Role } from '../src/shared/roles.ts';
import { SETUP_TOKEN_HEADER } from '../src/shared/setup.ts';
import { type FakeRoutes, startFakeServer } from './fake-server.ts';

/** Fixe le rôle d'un membre en base (aucun chemin de l'appli ne le fait : le propriétaire vient de l'amorçage). */
export function setRole(db: Pick<Db, 'update'>, id: string, role: Role): User {
  const user = db.update(users).set({ role }).where(eq(users.id, id)).returning().get();
  if (!user) throw new Error(`Membre introuvable : ${id}`);
  return user;
}

/**
 * Crée des dossiers temporaires, supprimés à la fin du fichier (ou du `describe`) appelant : après tous les afterEach,
 * donc après la fermeture des apps et des bases qui les ouvrent, quel que soit l'ordre des afterEach du lanceur
 * (inverse sous Vitest, ordre de déclaration sous Bun).
 */
export function trackTempDirs() {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-'));
    dirs.push(dir);
    return dir;
  };
}

/**
 * Délai des tests lents (migrations sur une base peuplée, routes qui créent plusieurs membres) : 20 s au lieu de 5.
 * Sur chaque test, pas sur leur `describe` : bun test 1.4.5 ignore le `timeout` des options d'un `describe`.
 */
export const SLOW_TEST = { timeout: 20_000 };

/** Crée des applications sur un dossier de données neuf, fermées (et nettoyées) après chaque test. */
export function trackApps() {
  const tempDir = trackTempDirs();
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });
  return async (options: Pick<Parameters<typeof buildApp>[0], 'upstreams' | 'onRoute'> = {}) => {
    const app = await buildApp({ data: openDataDir(tempDir()), ...options });
    apps.push(app);
    return app;
  };
}

/** Application, et ses routes `/api` enregistrées dans Fastify, en `MÉTHODE /motif` (les HEAD automatiques exclus). */
export async function appWithApiRoutes(newApp: ReturnType<typeof trackApps>) {
  const routes = new Set<string>();
  const app = await newApp({
    onRoute: ({ method, url }) => {
      for (const m of [method].flat()) if (m !== 'HEAD' && url.startsWith('/api')) routes.add(`${m} ${url}`);
    },
  });
  return { app, routes };
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
  const user = await memberAs(app, role, id);
  const { token } = createSession(app.data.db, user.id, null);
  return { user, headers: { cookie: `${SESSION_COOKIE}=${app.signCookie(token)}`, ...CSRF_HEADERS } };
}

/** Membre de ce rôle créé en base (un même `id` réutilise le même membre). */
async function memberAs(app: FastifyInstance, role: Role, id: string): Promise<User> {
  await app.ready();
  const { db } = app.data;
  const user = upsertFromEmby(db, { id, name: `Nom ${id}`, avatar: null, isEmbyAdmin: false });
  return user.role === role ? user : setRole(db, id, role);
}

/**
 * Session d'un client natif pour un membre de ce rôle, comme `POST /api/auth/emby-token` l'ouvre : `headers` ne porte
 * que `Authorization: Bearer`, ni cookie ni en-tête CSRF.
 */
export async function bearerAs(
  app: FastifyInstance,
  role: Role,
  id = `membre-${role}`,
  deviceName = 'Salon (Android TV)',
): Promise<TestSession & { token: string }> {
  const user = await memberAs(app, role, id);
  const { token } = createSession(app.data.db, user.id, 'okhttp/4.12.0', new Date(), deviceName);
  return { user, token, headers: { authorization: `Bearer ${token}` } };
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
