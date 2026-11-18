import type { FastifyInstance } from 'fastify';
import { type Member, memberUpdateSchema, USERS_IMPORT_PATH, USERS_PATH, userPath } from '../../shared/auth.ts';
import { ofMediaServer } from '../../shared/settings.ts';
import { labelOf } from '../integrations/media-server.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { requireCapability } from '../plugins/auth.ts';
import {
  getUser,
  importFromEmby,
  listUsers,
  setQuotaOverride,
  setRole,
  toMember,
  UsersError,
} from '../services/users.ts';

const AVATAR_TIMEOUT_MS = 8000;
const AVATAR_MAX_AGE_S = 24 * 3600;
/** Images matricielles seulement : jamais de SVG (scripts possibles) ni d'autre type relayé depuis Emby. */
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type IdParams = { Params: { id: string } };

export function usersRoutes(app: FastifyInstance) {
  const { db } = app.data;
  const members = () => listUsers(db).map(toMember);

  app.get(USERS_PATH, { preHandler: requireCapability('canManageRequests') }, async (): Promise<Member[]> => members());

  /** Crée les comptes actifs du serveur multimédia absents de l'appli ; jamais de promotion (voir importFromEmby). */
  app.post(USERS_IMPORT_PATH, { preHandler: requireCapability('canManageUsers') }, async (): Promise<Member[]> => {
    const embyUsers = await app.mediaServers.require().listUsers();
    db.transaction((tx) => {
      for (const u of embyUsers) {
        if (!u.isDisabled) importFromEmby(tx, { id: u.id, name: u.name, avatar: u.avatarUrl });
      }
    });
    return members();
  });

  app.put<IdParams>(
    userPath(':id'),
    { preHandler: requireCapability('canManageUsers') },
    async (req): Promise<Member> => {
      const { id } = req.params;
      const { role, quotaOverride } = parseRequest(memberUpdateSchema, req.body);
      // Le rôle d'abord : s'il est refusé (dernier propriétaire), rien n'est modifié.
      if (role !== undefined) setRole(db, id, role);
      if (quotaOverride !== undefined) setQuotaOverride(db, id, quotaOverride);
      const user = getUser(db, id);
      if (!user) throw new UsersError('not_found', 'Membre introuvable');
      return toMember(user);
    },
  );

  /**
   * Relais de la photo du membre (le navigateur ne voit ni l'adresse du serveur ni sa clé ; Plex : photo plex.tv, sans
   * jeton). `fetch` direct plutôt que `httpRequest` : ce dernier ne sait lire que du texte, ici le corps est une image.
   */
  app.get<IdParams>(userPath(':id', 'avatar'), async (req, reply) => {
    const user = getUser(db, req.params.id);
    if (!user?.avatar) throw new HttpError(404, 'Pas de photo');
    const server = app.mediaServers.require();
    const label = labelOf(server);
    const target = server.avatarRequest(user.avatar);
    if (!target) throw new HttpError(404, 'Pas de photo');
    let res: Response;
    try {
      res = await fetch(target.url, {
        headers: target.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, `${label} injoignable`);
    }
    if (!res.ok) throw new HttpError(404, `Photo introuvable chez ${label}`);
    // Type normalisé (sans paramètres) : seul un type de la liste est relayé, et tel que nous l'écrivons.
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!AVATAR_TYPES.has(type)) throw new HttpError(502, `Réponse inattendue ${ofMediaServer(server.kind)}`);
    return reply
      .header('content-type', type)
      .header('cache-control', `private, max-age=${AVATAR_MAX_AGE_S}`)
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(await res.arrayBuffer()));
  });
}
