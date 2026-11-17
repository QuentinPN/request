import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { SESSION_COOKIE } from '../src/server/plugins/auth.ts';
import { createSession } from '../src/server/services/sessions.ts';
import { setRole, type User, upsertFromEmby } from '../src/server/services/users.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import type { Role } from '../src/shared/roles.ts';
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
  return async () => {
    const app = await buildApp({ data: openDataDir(tempDir()) });
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
