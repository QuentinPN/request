import type { Page, Route } from '@playwright/test';
import type { Member } from '../src/shared/auth.ts';
import type { MediaSummary, MediaType } from '../src/shared/media.ts';
import {
  type BatchRequestInput,
  type CreateRequestInput,
  REQUESTS_PAGE_SIZE,
  type RequestDetail,
  type RequestPage,
  type RequestPerson,
  type RequestQuota,
  requestListQuerySchema,
  type SendOptions,
} from '../src/shared/requests.ts';
import {
  activeRequestStatuses,
  type RequestEventType,
  type RequestStatus,
  requestStatuses,
} from '../src/shared/status.ts';
import { fixtures } from './catalogue-mocks.ts';

// Faux `/api/requests*` : demandes en mémoire, typées par le contrat partagé. Une seule source pour Mes demandes
// (feuille de demande, bande de Découvrir, fiche) et pour la file d'approbation.

export const quentin: RequestPerson = { id: 'id-owner', name: 'Quentin', avatarUrl: null };
export const person = (name: string): RequestPerson => ({ id: `id-${name}`, name, avatarUrl: null });
/** Membre de `/api/users` (sélecteur de la feuille pour autrui), même id que `person(name)`. */
export const memberNamed = (name: string): Member => ({
  ...person(name),
  role: 'member',
  quotaOverride: null,
  lastLoginAt: null,
});

/** Raison d'un envoi refusé par Radarr, affichée dans l'onglet Échecs. */
const FAILURE = 'Radarr a refusé l’ajout (dossier /films plein)';
const eventDetail: Partial<Record<RequestEventType, string>> = { sent: 'HD-1080p · /series', failed: FAILURE };

const catalogue = [...fixtures.discover.rows.flatMap((row) => row.items), fixtures.tv, fixtures.movie];
/** Résumé d'un titre des fixtures, par son nom. */
export function mediaNamed(title: string): MediaSummary {
  const media = catalogue.find((m) => m.title === title);
  if (!media) throw new Error(`Titre absent des fixtures : ${title}`);
  const { tmdbId, type, year, posterPath, backdropPath, overview, status, progress } = media;
  return { tmdbId, type, title: media.title, year, posterPath, backdropPath, overview, status, progress };
}

/** Titre hors des fixtures du catalogue (file d'approbation) : sans affiche, avec un synopsis de circonstance. */
export function stubMedia(tmdbId: number, title: string, type: MediaType = 'movie'): MediaSummary {
  return {
    tmdbId,
    type,
    title,
    year: 2024,
    posterPath: null,
    backdropPath: null,
    overview: `Synopsis de ${title} : une histoire qui tient en quelques lignes pour la maquette.`,
  };
}

let nextId = 1;
const at = (day: number, hour = 20, minute = 2) => new Date(2026, 10, day, hour, minute).toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface RequestOptions {
  seasons?: number[];
  /** Faits de la frise, du plus ancien au plus récent. */
  events?: RequestEventType[];
  declineReason?: string | null;
  /** Jour de novembre 2026 de la demande, à 20 h 02. */
  day?: number;
  id?: number;
  requester?: RequestPerson;
  decidedBy?: RequestPerson | null;
  /** Remplace `day`. */
  createdAt?: string;
  qualityProfileId?: number | null;
  rootFolder?: string | null;
  is4k?: boolean;
  server?: RequestDetail['server'];
  /** Gestionnaire qui l'a faite à la place du membre. */
  createdBy?: RequestPerson | null;
  quotaExempt?: boolean;
}

const actorOf = (type: RequestEventType) =>
  type === 'sent' || type === 'failed' || type === 'available' ? null : quentin;

/** Demande de test. */
export function makeRequest(
  media: MediaSummary,
  status: RequestStatus,
  {
    seasons = [],
    events = ['requested'],
    declineReason = null,
    day = 13,
    id = nextId++,
    requester = quentin,
    decidedBy = status === 'pending' || status === 'cancelled' ? null : quentin,
    createdAt = at(day),
    qualityProfileId = null,
    rootFolder = null,
    is4k = false,
    server = null,
    createdBy = null,
    quotaExempt = false,
  }: RequestOptions = {},
): RequestDetail {
  return {
    id,
    type: media.type,
    tmdbId: media.tmdbId,
    status,
    seasons,
    requester,
    createdBy,
    quotaExempt,
    decidedBy,
    declineReason,
    qualityProfileId,
    rootFolder,
    seriesType: null,
    is4k,
    server,
    createdAt,
    updatedAt: createdAt,
    media,
    failureReason: status === 'failed' ? FAILURE : null,
    events: events.map((type, i) => ({
      id: id * 100 + i,
      type,
      actor: actorOf(type),
      detail: eventDetail[type] ?? null,
      createdAt: at(day, 20, 2 + i * 29),
    })),
  };
}

export const quotaOf = (movies: number, seasons: number): RequestQuota => ({
  movies: { limit: 10, days: 7, used: 10 - movies, remaining: movies },
  seasons: { limit: 5, days: 7, used: 5 - seasons, remaining: seasons },
  exempt: false,
});

/** File d'approbation : trois demandes en attente, un échec d'envoi, une envoyée, une refusée. */
export const approvalQueue = (): RequestDetail[] => {
  const [marion, theo, lea] = [person('Marion'), person('Théo'), person('Léa')];
  const recent = ago(12 * 60_000);
  return [
    makeRequest(stubMedia(1001, 'Conclave'), 'pending', { id: 1, requester: marion, createdAt: recent }),
    makeRequest(stubMedia(1002, 'Andor', 'tv'), 'pending', {
      id: 2,
      requester: theo,
      seasons: [1, 2],
      createdAt: ago(2 * 3_600_000),
    }),
    makeRequest(stubMedia(1003, 'Furiosa'), 'pending', { id: 3, requester: lea, createdAt: ago(26 * 3_600_000) }),
    makeRequest(stubMedia(1004, 'Gladiator II'), 'failed', {
      id: 4,
      requester: marion,
      events: ['requested', 'approved', 'failed'],
      qualityProfileId: 4,
      rootFolder: '/films',
      createdAt: recent,
    }),
    makeRequest(stubMedia(1005, 'Dune'), 'sent', {
      id: 5,
      requester: theo,
      events: ['requested', 'approved', 'sent'],
      qualityProfileId: 4,
      createdAt: recent,
    }),
    makeRequest(stubMedia(1006, 'Tenet'), 'declined', {
      id: 6,
      requester: lea,
      declineReason: 'Déjà dans la bibliothèque',
      createdAt: recent,
    }),
  ];
};

/** Listes de Radarr que lit l'approbateur, avec les valeurs par défaut des réglages. */
export const radarrOptions: SendOptions = {
  servers: [{ id: 1, name: 'Radarr', is4k: false, isDefault: true }],
  serverId: 1,
  defaultProfileId: 4,
  defaultFolder: '/films',
  qualityProfiles: [
    { id: 4, name: 'HD-1080p' },
    { id: 5, name: 'Ultra-HD' },
  ],
  rootFolders: [
    { id: 1, path: '/films', freeSpace: 412 * 1024 ** 3 },
    { id: 2, path: '/films-4k', freeSpace: 1.8 * 1024 ** 4 },
  ],
};

const isActive = (status: RequestStatus) => (activeRequestStatuses as readonly string[]).includes(status);

export class RequestsMock {
  /** Plus récentes en premier, comme le serveur. */
  requests: RequestDetail[] = [];
  quota = quotaOf(7, 3);
  /** Quotas lus : `moi`, ou l'id du membre pour qui la feuille demande. */
  quotaReads: string[] = [];
  /** Corps des POST /api/requests reçus. */
  posts: CreateRequestInput[] = [];
  /** Réponse d'erreur à servir aux créations. */
  createError: { status: number; error: string } | null = null;
  /** Statut que prend une demande approuvée ou relancée : `failed` simule un refus de Radarr. */
  sendOutcome: RequestStatus = 'sent';
  approvals: { id: number; body: unknown }[] = [];
  declines: { id: number; body: unknown }[] = [];
  retries: number[] = [];
  batches: BatchRequestInput[] = [];
  /**
   * Réponses de `/api/requests/send-options/:type` (clé `movie-4k` pour `?is4k=true`) ; absent : service pas encore
   * configuré (503). Avec `?serverId=`, les mêmes listes, ce serveur choisi.
   */
  sendOptions: Partial<Record<MediaType | `${MediaType}-4k`, SendOptions>> = {};
  /** Requêtes de listes reçues (`type`, `is4k`, `serverId`), pour vérifier le serveur demandé. */
  optionReads: string[] = [];

  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async install() {
    await this.page.route(
      (url) => url.pathname.startsWith('/api/requests'),
      (route) => this.handle(route),
    );
    return this;
  }

  private find(id: number) {
    const request = this.requests.find((r) => r.id === id);
    if (!request) throw new Error(`demande ${id} inconnue`);
    return request;
  }

  private record(request: RequestDetail, status: RequestStatus, type: RequestEventType) {
    request.status = status;
    request.updatedAt = new Date().toISOString();
    request.events.push({
      id: request.id * 100 + request.events.length,
      type,
      actor: actorOf(type),
      detail: eventDetail[type] ?? null,
      createdAt: request.updatedAt,
    });
    request.failureReason = status === 'failed' ? FAILURE : null;
    return request;
  }

  /** Envoi à Radarr, après une approbation ou une relance. */
  private send(request: RequestDetail) {
    return this.record(request, this.sendOutcome, this.sendOutcome === 'failed' ? 'failed' : 'sent');
  }

  private decline(request: RequestDetail, reason: string | null) {
    request.declineReason = reason;
    return this.record(request, 'declined', 'declined');
  }

  private batch(body: BatchRequestInput) {
    return {
      results: body.ids.map((id) => {
        const request = this.find(id);
        return {
          id,
          ok: true as const,
          request: body.action === 'approve' ? this.send(request) : this.decline(request, body.reason ?? null),
        };
      }),
    };
  }

  private async handle(route: Route) {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/api/requests') {
      // Même contrat que le serveur : la requête est lue par le schéma partagé.
      const query = requestListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return json(400, { error: 'Requête invalide' });
      const { status, type, tmdbId, mine, page } = query.data;
      const scope = this.requests.filter(
        (r) =>
          (!mine || r.requester.id === quentin.id) &&
          (!type || r.type === type) &&
          (tmdbId === undefined || r.tmdbId === tmdbId),
      );
      const matching = scope.filter((r) => !status || status.includes(r.status));
      const start = (page - 1) * REQUESTS_PAGE_SIZE;
      const totals = Object.fromEntries(
        requestStatuses.map((s) => [s, scope.filter((r) => r.status === s).length]),
      ) as RequestPage['totals'];
      return json(200, {
        page,
        totalPages: Math.ceil(matching.length / REQUESTS_PAGE_SIZE),
        results: matching.slice(start, start + REQUESTS_PAGE_SIZE).map(({ events: _, ...view }) => view),
        totals,
      } satisfies RequestPage);
    }
    const optionsOf = path.match(/^\/api\/requests\/send-options\/(movie|tv)$/)?.[1] as MediaType | undefined;
    if (method === 'GET' && optionsOf) {
      const is4k = url.searchParams.get('is4k') === 'true';
      const serverId = url.searchParams.get('serverId');
      this.optionReads.push(`${optionsOf}${is4k ? '-4k' : ''}${serverId ? `:${serverId}` : ''}`);
      const options = this.sendOptions[is4k ? (`${optionsOf}-4k` as const) : optionsOf];
      if (!options) return json(503, { error: "Radarr n'est pas encore configuré" });
      return json(200, serverId ? { ...options, serverId: Number(serverId) } : options);
    }
    if (method === 'GET' && path === '/api/requests/quota') {
      this.quotaReads.push(url.searchParams.get('userId') ?? 'moi');
      return json(200, this.quota);
    }
    if (method === 'GET' && path === '/api/requests/counts')
      return json(200, {
        pendingApprovals: this.requests.filter((r) => r.status === 'pending').length,
        mineActive: this.requests.filter((r) => r.requester.id === quentin.id && isActive(r.status)).length,
      });
    if (method === 'POST' && path === '/api/requests/batch') {
      const body = route.request().postDataJSON() as BatchRequestInput;
      this.batches.push(body);
      return json(200, this.batch(body));
    }
    const id = Number(path.match(/^\/api\/requests\/(\d+)/)?.[1]);
    const found = this.requests.find((r) => r.id === id);
    if (method === 'GET' && found) return json(200, found);
    if (method === 'POST' && path === '/api/requests') {
      const input = route.request().postDataJSON() as CreateRequestInput;
      this.posts.push(input);
      // Le temps de voir le bouton désactivé pendant l'envoi.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (this.createError) return json(this.createError.status, { error: this.createError.error });
      const media = catalogue.find((m) => m.type === input.type && m.tmdbId === input.tmdbId);
      if (!media) return json(404, { error: 'Introuvable' });
      const created = makeRequest(mediaNamed(media.title), 'pending', {
        seasons: input.type === 'tv' && Array.isArray(input.seasons) ? input.seasons : [],
        is4k: input.is4k ?? false,
      });
      this.requests.unshift(created);
      return json(201, created);
    }
    if (method === 'POST' && found && path.endsWith('/cancel')) {
      if (found.status !== 'pending') return json(409, { error: 'Cette demande ne peut plus être annulée' });
      return json(200, this.record(found, 'cancelled', 'cancelled'));
    }
    if (method === 'POST' && found && path.endsWith('/approve')) {
      this.approvals.push({ id, body: route.request().postDataJSON() });
      return json(200, this.send(found));
    }
    if (method === 'POST' && found && path.endsWith('/retry')) {
      this.retries.push(id);
      return json(200, this.send(found));
    }
    if (method === 'POST' && found && path.endsWith('/decline')) {
      const body = route.request().postDataJSON() as { reason: string };
      this.declines.push({ id, body });
      return json(200, this.decline(found, body.reason));
    }
    return json(404, { error: 'Introuvable' });
  }
}

export const mockRequests = (page: Page) => new RequestsMock(page).install();

/** File d'approbation : les demandes de `approvalQueue` et les listes de Radarr qu'y lit l'approbateur. */
export async function mockApprovalQueue(page: Page) {
  const requests = await mockRequests(page);
  requests.requests = approvalQueue();
  requests.sendOptions = { movie: radarrOptions };
  return requests;
}
