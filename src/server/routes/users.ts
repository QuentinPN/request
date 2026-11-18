import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  type Member,
  type MemberOption,
  membersBulkUpdateSchema,
  memberUpdateSchema,
  USERS_BULK_PATH,
  USERS_DEFAULTS_PATH,
  USERS_IMPORT_PATH,
  USERS_PATH,
  userPath,
} from '../../shared/auth.ts';
import { permissionOverridesOf, quotaEditRefusal } from '../../shared/roles.ts';
import { ofMediaServer, settingSchemas } from '../../shared/settings.ts';
import { users } from '../db/schema.ts';
import { labelOf } from '../integrations/media-server.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { ownerOnly, requireCapability, viewerOf } from '../plugins/auth.ts';
import { revokeAllForUser } from '../services/sessions.ts';
import { setSetting } from '../services/settings.ts';
import {
  applyAccessChange,
  getUser,
  importFromEmby,
  listUsers,
  type MemberDefaults,
  memberDefaultsOf,
  setQuotaOverride,
  toMember,
  toMemberOption,
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

  // Liste des membres : gestion des demandes (filtre par membre), demande pour autrui (choix du membre), Membres.
  // Droits et quotas des membres : pour qui gère les membres seulement ; les autres ne reçoivent que `MemberOption`.
  app.get(
    USERS_PATH,
    { preHandler: requireCapability('canManageRequests', 'canRequestOnBehalf', 'canManageUsers') },
    async (req): Promise<Member[] | MemberOption[]> =>
      req.viewer?.capabilities.canManageUsers ? members() : listUsers(db).map(toMemberOption),
  );

  const canManageUsers = { preHandler: requireCapability('canManageUsers') };

  /**
   * Crée les comptes actifs du serveur multimédia absents de l'appli, avec les droits par défaut ; jamais de promotion
   * (voir importFromEmby).
   */
  app.post(USERS_IMPORT_PATH, canManageUsers, async (): Promise<Member[]> => {
    const embyUsers = await app.mediaServers.require().listUsers();
    const defaults = memberDefaultsOf(app.data);
    db.transaction((tx) => {
      for (const u of embyUsers) {
        if (!u.isDisabled) importFromEmby(tx, { id: u.id, name: u.name, avatar: u.avatarUrl }, new Date(), defaults);
      }
    });
    return members();
  });

  /**
   * Rôle, droits et quotas d'un membre, en une transaction : si un changement est refusé, rien n'est écrit. Garde contre
   * l'escalade (`memberEditRefusal`) pour tout changement, quotas compris : le propriétaire n'est jamais modifié ici.
   */
  app.put<IdParams>(userPath(':id'), canManageUsers, async (req): Promise<Member> => {
    const { id } = req.params;
    const { quotaOverride, ...access } = parseRequest(memberUpdateSchema, req.body);
    const actor = viewerOf(req).capabilities;
    const updated = db.transaction((tx) => {
      const user = tx.select().from(users).where(eq(users.id, id)).get();
      if (!user) throw new UsersError('not_found', 'Membre introuvable');
      const next = applyAccessChange(tx, actor, user, access);
      // Un quota inchangé (le client renvoie celui qu'il a lu) n'est pas un réglage.
      if (quotaOverride !== undefined && !isDeepStrictEqual(quotaOverride, user.quotaOverride ?? null)) {
        const refusal = quotaEditRefusal(actor);
        if (refusal) throw new UsersError('forbidden', refusal);
      }
      return quotaOverride !== undefined ? setQuotaOverride(tx, id, quotaOverride) : next;
    });
    return toMember(updated);
  });

  /**
   * Plusieurs membres d'un coup : un rôle (son préréglage) et des droits accordés ou retirés, en une transaction. Un
   * seul membre refusé (garde contre l'escalade, inconnu) et rien n'est écrit ; le refus nomme le membre.
   */
  app.post(USERS_BULK_PATH, canManageUsers, async (req): Promise<Member[]> => {
    const { ids, role, permissions: changes } = parseRequest(membersBulkUpdateSchema, req.body);
    const actor = viewerOf(req).capabilities;
    db.transaction((tx) => {
      for (const id of new Set(ids)) {
        const user = tx.select().from(users).where(eq(users.id, id)).get();
        if (!user) throw new UsersError('not_found', 'Membre introuvable');
        try {
          applyAccessChange(tx, actor, user, { role, changes });
        } catch (error) {
          if (error instanceof UsersError) throw new UsersError(error.code, `${user.name} : ${error.message}`);
          throw error;
        }
      }
    });
    return members();
  });

  /** « Droits par défaut » des nouveaux membres : propriétaire seulement (un défaut « Gestionnaire » serait une escalade). */
  app.get(USERS_DEFAULTS_PATH, ownerOnly, async (): Promise<MemberDefaults> => memberDefaultsOf(app.data));

  app.put(USERS_DEFAULTS_PATH, ownerOnly, async (req): Promise<MemberDefaults> => {
    const { role, permissions } = parseRequest(settingSchemas.memberDefaults, req.body);
    const stored = { role, permissions: permissions && permissionOverridesOf(role, permissions) };
    setSetting(db, app.data.cryptoKey, 'memberDefaults', stored);
    return stored;
  });

  /** « Déconnecter partout » : révoque toutes les sessions du membre (propriétaire seulement). */
  app.delete<IdParams>(userPath(':id', 'sessions'), ownerOnly, async (req, reply) => {
    if (!getUser(db, req.params.id)) throw new UsersError('not_found', 'Membre introuvable');
    revokeAllForUser(db, req.params.id);
    return reply.code(204).send();
  });

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
