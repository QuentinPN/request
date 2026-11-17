import { and, eq, exists, isNotNull, isNull, lt, not, or, type SQL } from 'drizzle-orm';
import type { MediaKey } from '../../shared/media.ts';
import type { WebhookResult, WebhookService } from '../../shared/webhooks.ts';
import type { Data, Db } from '../db/index.ts';
import { issues, media, requests } from '../db/schema.ts';
import type { ArrWebhookEvent } from '../integrations/arr.ts';
import { latestEmbyItems } from '../integrations/emby.ts';
import { parseRadarrWebhook } from '../integrations/radarr.ts';
import { parseSonarrWebhook } from '../integrations/sonarr.ts';
import { one } from '../lib/sql.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time.ts';
import { listArrServers } from './arr-servers.ts';
import type { AvailabilityService } from './availability.ts';
import { lastFailureAt, lastSuccessAt, runJob } from './jobs.ts';
import { NOTIFICATION_RETENTION_MS, purgeReadNotifications } from './notifications.ts';
import { getSetting } from './settings.ts';

/** Noms des balayages dans `job_runs` (verrou : une seule exécution `running` par nom). */
export const SCAN_JOBS = { light: 'scan:light', full: 'scan:full' } as const;
/** Balayage léger : derniers ajouts d'Emby, titres en téléchargement et demandes envoyées. */
export const LIGHT_SCAN_INTERVAL_MS = 10 * MINUTE_MS;
/** Balayage complet : tous les titres ayant un statut ou une demande, et purge des titres oubliés. */
export const FULL_SCAN_INTERVAL_MS = DAY_MS;
/** Après un balayage complet en échec, délai minimal avant le suivant. */
export const FULL_SCAN_RETRY_MS = HOUR_MS;
/** Premier tour peu après le démarrage, sans retarder celui du serveur. */
const FIRST_TICK_DELAY_MS = 5 * 1000;
/** Derniers ajouts d'Emby relus par le balayage léger. */
const RECENT_LIMIT = 50;
/** Titres recalculés par lot : la lecture `(type, tmdb_id) IN (VALUES …)` reste courte. */
const SCAN_BATCH = 200;
/** Un titre sans statut ni demande, ni recalculé (vu sur une affiche) depuis ce délai, est supprimé. */
export const PURGE_AFTER_MS = 30 * DAY_MS;

const hasRequest = (db: Db, where?: SQL) =>
  exists(
    db
      .select({ one })
      .from(requests)
      .where(and(eq(requests.mediaId, media.id), where)),
  );

/** Un signalement retient son titre (clé étrangère `RESTRICT`). */
const hasIssue = (db: Db) => exists(db.select({ one }).from(issues).where(eq(issues.mediaId, media.id)));

/**
 * Supprime les titres sans statut, normal ni 4K (absents d'Emby, Radarr et Sonarr), sans aucune demande ni
 * signalement et pas recalculés depuis `before` : les affiches vues une fois s'accumuleraient sinon. Leurs saisons
 * partent en cascade.
 */
export function purgeMedia(db: Db, before: Date): number {
  return db
    .delete(media)
    .where(
      and(
        isNull(media.status),
        isNull(media.status4k),
        lt(media.statusUpdatedAt, before),
        not(hasRequest(db)),
        not(hasIssue(db)),
      ),
    )
    .run().changes;
}

/**
 * Synchronisation avec Radarr, Sonarr et Emby : webhooks entrants et balayages. Tout passe par le calcul unique du
 * statut (`availability.refresh`), qui fait aussi passer `available` les demandes envoyées arrivées.
 */
export function createSync(data: Data, deps: { availability: AvailabilityService; now?: () => number }) {
  const { db, cryptoKey } = data;
  const { availability } = deps;
  const now = deps.now ?? Date.now;

  /** Titre concerné par un webhook, s'il est connu de l'appli (un titre inconnu n'a ni cache ni demande). */
  function mediaOf(service: WebhookService, event: ArrWebhookEvent) {
    const ids = [
      event.tmdbId !== undefined && eq(media.tmdbId, event.tmdbId),
      // Sonarr v3 ne donne que l'id TVDB.
      service === 'sonarr' && event.tvdbId !== undefined && eq(media.tvdbId, event.tvdbId),
    ].filter((c): c is SQL => c !== false);
    if (ids.length === 0) return undefined;
    return db
      .select({ id: media.id, type: media.type, tmdbId: media.tmdbId })
      .from(media)
      .where(and(eq(media.type, service === 'radarr' ? 'movie' : 'tv'), or(...ids)))
      .get();
  }

  /**
   * Webhook Radarr/Sonarr (jeton déjà vérifié), d'un serveur identifié par `serverId` (`?server=` de l'adresse).
   * Grab → « en téléchargement » dans la qualité du serveur ; Download et suppressions → recalcul de ce seul titre,
   * liste et file du serveur relues ; Test → accusé de réception ; le reste est ignoré. Serveur absent, inconnu ou d'un
   * autre type (adresse collée avant les serveurs multiples) : le seul serveur du type s'il n'y en a qu'un, sinon le
   * titre est recalculé avec les listes de tous les serveurs du type relues, un Grab compris (sa qualité est alors
   * inconnue, la file la donne).
   */
  async function handleWebhook(service: WebhookService, body: unknown, serverId?: number): Promise<WebhookResult> {
    const event = service === 'radarr' ? parseRadarrWebhook(body) : parseSonarrWebhook(body);
    if (event.event === 'test') return { handled: true };
    if (event.event === 'other') return { handled: false };
    const row = mediaOf(service, event);
    if (!row) return { handled: false };
    const ofType = listArrServers(data).filter((s) => s.type === service);
    const server = ofType.find((s) => s.id === serverId) ?? (ofType.length === 1 ? ofType[0] : undefined);
    if (event.event === 'grab' && server) availability.markDownloading(server, row.id, event.seasons);
    else await availability.refresh([row], { forget: service, ...(server && { serverId: server.id }) });
    return { handled: true };
  }

  async function refreshAll(keys: readonly MediaKey[]) {
    for (let i = 0; i < keys.length; i += SCAN_BATCH) await availability.refresh(keys.slice(i, i + SCAN_BATCH));
  }

  const keysWhere = (where: SQL | undefined) =>
    db.select({ type: media.type, tmdbId: media.tmdbId }).from(media).where(where).all();

  /** Balayage léger : derniers ajouts d'Emby, titres en téléchargement et titres des demandes envoyées. */
  const lightScan = () =>
    runJob(db, SCAN_JOBS.light, async () => {
      const emby = getSetting(db, cryptoKey, 'emby');
      const recent = emby ? await latestEmbyItems(emby, { libraryIds: emby.libraryIds, limit: RECENT_LIMIT }) : [];
      const watched = keysWhere(
        or(
          eq(media.status, 'downloading'),
          eq(media.status4k, 'downloading'),
          hasRequest(db, eq(requests.status, 'sent')),
        ),
      );
      const keys = [...recent.map(({ type, tmdbId }) => ({ type, tmdbId })), ...watched];
      await refreshAll(keys);
      return `${keys.length} titres recalculés`;
    });

  /**
   * Balayage complet : purges d'abord (titres oubliés, qu'un recalcul rajeunirait, et notifications lues de plus de
   * 90 jours), puis tout titre suivi.
   */
  const fullScan = () =>
    runJob(db, SCAN_JOBS.full, async () => {
      const purged = purgeMedia(db, new Date(now() - PURGE_AFTER_MS));
      purgeReadNotifications(db, new Date(now() - NOTIFICATION_RETENTION_MS));
      const keys = keysWhere(or(isNotNull(media.status), isNotNull(media.status4k), hasRequest(db)));
      await refreshAll(keys);
      return `${keys.length} titres recalculés, ${purged} supprimés`;
    });

  return { handleWebhook, lightScan, fullScan };
}

export type SyncService = ReturnType<typeof createSync>;

/**
 * Balayages planifiés dans le processus (sans dépendance) : un tour peu après le démarrage puis toutes les
 * `LIGHT_SCAN_INTERVAL_MS`. Un tour lance le balayage léger, suivi du complet si le dernier réussi date de plus d'un
 * jour et que le dernier échec date de plus d'une heure (lus dans `job_runs` : un redémarrage ne repousse ni n'accélère
 * rien). Un tour encore en cours fait sauter le suivant. `stop` arrête les minuteurs et attend le tour en cours (avant
 * de fermer la base).
 */
export function startScheduler(sync: SyncService, db: Db, now: () => number = Date.now) {
  let current: Promise<void> | null = null;
  const isOlderThan = (at: Date | null, ms: number) => !at || now() - at.getTime() >= ms;
  const tick = async () => {
    await sync.lightScan();
    if (
      isOlderThan(lastSuccessAt(db, SCAN_JOBS.full), FULL_SCAN_INTERVAL_MS) &&
      isOlderThan(lastFailureAt(db, SCAN_JOBS.full), FULL_SCAN_RETRY_MS)
    )
      await sync.fullScan();
  };
  const run = () => {
    if (current) return;
    current = tick()
      .catch((error: unknown) => console.error('Balayage planifié', error))
      .finally(() => {
        current = null;
      });
  };
  const first = setTimeout(run, FIRST_TICK_DELAY_MS);
  const timer = setInterval(run, LIGHT_SCAN_INTERVAL_MS);
  first.unref();
  timer.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
    },
  };
}
