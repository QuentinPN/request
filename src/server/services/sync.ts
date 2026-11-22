import { and, eq, exists, isNotNull, isNull, lt, not, or, type SQL } from 'drizzle-orm';
import { JOB, jobDefinitions } from '../../shared/jobs.ts';
import type { MediaKey } from '../../shared/media.ts';
import { plural } from '../../shared/text.ts';
import type { WebhookResult, WebhookService } from '../../shared/webhooks.ts';
import { changes, type Data, type Db } from '../db/index.ts';
import { issues, media, requests } from '../db/schema.ts';
import type { ArrWebhookEvent } from '../integrations/arr.ts';
import { labelOf, type MediaServer } from '../integrations/media-server.ts';
import { parseRadarrWebhook } from '../integrations/radarr.ts';
import { parseSonarrWebhook } from '../integrations/sonarr.ts';
import { startPeriodic } from '../lib/periodic.ts';
import { one } from '../lib/sql.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time.ts';
import { listArrServers } from './arr-servers.ts';
import type { AvailabilityService } from './availability.ts';
import { type JobLog, lastFailureAt, lastSuccessAt, launchJob, runJob } from './jobs.ts';
import type { MediaServers } from './media-server.ts';
import { purgeOldNotifications } from './notifications.ts';
import { purgeExpired, revokeDepartedMembers } from './sessions.ts';

/** Noms des balayages dans `job_runs` (verrou : une seule exécution `running` par nom). */
export const SCAN_JOBS = { light: JOB.scanLight, full: JOB.scanFull } as const;
/** Fréquences par défaut des balayages (réglables par le propriétaire, `jobs.intervalMinutes`). */
const defaultInterval = (job: typeof JOB.scanLight | typeof JOB.scanFull) =>
  (jobDefinitions[job].interval?.default ?? 0) * MINUTE_MS;
/** Balayage léger : derniers ajouts d'Emby, titres en téléchargement et demandes envoyées. */
export const LIGHT_SCAN_INTERVAL_MS = defaultInterval(SCAN_JOBS.light);
/** Balayage complet : tous les titres ayant un statut ou une demande, et purge des titres oubliés. */
export const FULL_SCAN_INTERVAL_MS = defaultInterval(SCAN_JOBS.full);
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
  return changes(
    db
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
      .run(),
  );
}

/**
 * Synchronisation avec Radarr, Sonarr et Emby : webhooks entrants et balayages. Tout passe par le calcul unique du
 * statut (`availability.refresh`), qui fait aussi passer `available` les demandes envoyées arrivées.
 */
export function createSync(
  data: Data,
  deps: { availability: AvailabilityService; mediaServers: MediaServers; now?: () => number; log?: JobLog },
) {
  const { db } = data;
  const { availability, mediaServers, log } = deps;
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

  /**
   * Déconnecte les membres dont le compte a disparu du serveur multimédia ou y est désactivé (voir
   * `revokeDepartedMembers`). Serveur absent, injoignable ou en erreur : rien n'est révoqué. Renvoie ce qu'il faut
   * ajouter au résumé du balayage (`job_runs.detail`), qui garde la trace.
   */
  async function revokeDeparted(): Promise<string> {
    let server: MediaServer | null | undefined;
    let accounts: Awaited<ReturnType<MediaServer['listUsers']>>;
    try {
      server = mediaServers.current();
      if (!server) return '';
      accounts = await server.listUsers();
    } catch {
      return `, membres non vérifiés (${server ? labelOf(server) : 'serveur multimédia'} indisponible)`;
    }
    const { revoked, sparedOwners } = revokeDepartedMembers(db, accounts);
    return [
      revoked > 0 && `, ${plural(revoked, 'membre déconnecté', 'membres déconnectés')}`,
      sparedOwners > 0 && ', propriétaire conservé (absent du serveur, mais le dernier)',
    ]
      .filter(Boolean)
      .join('');
  }

  /** Balayage léger : derniers ajouts d'Emby, titres en téléchargement et titres des demandes envoyées. */
  const lightWork = async () => {
    const recent = await availability.latestOnServer(RECENT_LIMIT);
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
  };

  /**
   * Balayage complet : purges d'abord (titres oubliés, qu'un recalcul rajeunirait, notifications lues de plus de
   * 90 jours ou non lues de plus d'un an et sessions expirées), puis tout titre suivi.
   */
  const fullWork = async () => {
    const purged = purgeMedia(db, new Date(now() - PURGE_AFTER_MS));
    purgeOldNotifications(db, new Date(now()));
    purgeExpired(db, new Date(now()));
    // Avant le recalcul des titres : une panne du serveur multimédia ne doit pas le sauter (il est alors seulement noté).
    const members = await revokeDeparted();
    const keys = keysWhere(or(isNotNull(media.status), isNotNull(media.status4k), hasRequest(db)));
    await refreshAll(keys);
    return `${keys.length} titres recalculés, ${purged} supprimés${members}`;
  };

  const lightScan = () => runJob(db, SCAN_JOBS.light, lightWork, log);
  const fullScan = () => runJob(db, SCAN_JOBS.full, fullWork, log);
  /** Lancent le balayage sans l'attendre (« Lancer maintenant ») : `null` si une exécution est déjà en cours. */
  const launch = {
    [SCAN_JOBS.light]: () => launchJob(db, SCAN_JOBS.light, lightWork, log),
    [SCAN_JOBS.full]: () => launchJob(db, SCAN_JOBS.full, fullWork, log),
  };

  return { handleWebhook, lightScan, fullScan, launch };
}

export type SyncService = ReturnType<typeof createSync>;

/** Fréquences courantes des balayages, en millisecondes (réglage `jobs` du propriétaire, relu à chaque tour). */
export interface ScanIntervals {
  lightMs: number;
  fullMs: number;
}

const DEFAULT_INTERVALS = (): ScanIntervals => ({ lightMs: LIGHT_SCAN_INTERVAL_MS, fullMs: FULL_SCAN_INTERVAL_MS });

/**
 * Balayages planifiés dans le processus (sans dépendance) : un tour peu après le démarrage puis toutes les
 * `lightMs` (5 à 60 minutes, 10 par défaut). Un tour lance le balayage léger, suivi du complet si le dernier réussi
 * date de plus de `fullMs` (6 à 72 heures, un jour par défaut) et que le dernier échec date de plus d'une heure (lus
 * dans `job_runs` : un redémarrage ne repousse ni n'accélère rien). Un tour encore en cours fait sauter le suivant.
 * `reschedule` applique les fréquences courantes sans redémarrage ; `nextLightAt` et `nextFullAt` donnent le prochain
 * tour de chaque balayage ; `stop` arrête les minuteurs et attend le tour en cours (avant de fermer la base).
 */
export function startScheduler(
  sync: SyncService,
  db: Db,
  { now = Date.now, intervals = DEFAULT_INTERVALS }: { now?: () => number; intervals?: () => ScanIntervals } = {},
) {
  const isOlderThan = (at: Date | null, ms: number) => !at || now() - at.getTime() >= ms;
  const tick = async () => {
    await sync.lightScan();
    if (
      isOlderThan(lastSuccessAt(db, SCAN_JOBS.full), intervals().fullMs) &&
      isOlderThan(lastFailureAt(db, SCAN_JOBS.full), FULL_SCAN_RETRY_MS)
    )
      await sync.fullScan();
  };
  const periodic = startPeriodic('Balayage planifié', tick, {
    firstDelayMs: FIRST_TICK_DELAY_MS,
    intervalMs: intervals().lightMs,
  });
  return {
    stop: periodic.stop,
    reschedule: () => periodic.setIntervalMs(intervals().lightMs),
    /** Prochain tour du balayage léger. */
    nextLightAt: periodic.nextRunAt,
    /** Prochain tour qui lancera le balayage complet : le premier tour passé l'échéance (dernier succès + fréquence). */
    nextFullAt(): number {
      const { lightMs, fullMs } = intervals();
      const success = lastSuccessAt(db, SCAN_JOBS.full);
      const failure = lastFailureAt(db, SCAN_JOBS.full);
      const due = Math.max(
        success ? success.getTime() + fullMs : 0,
        failure ? failure.getTime() + FULL_SCAN_RETRY_MS : 0,
      );
      const next = periodic.nextRunAt();
      return due <= next ? next : next + Math.ceil((due - next) / lightMs) * lightMs;
    },
  };
}

export type Scheduler = ReturnType<typeof startScheduler>;
