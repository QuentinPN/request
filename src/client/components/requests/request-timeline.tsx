import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import type { MediaKey } from '../../../shared/media.ts';
import { REQUEST_EDITED_DETAIL, type RequestDetail, type RequestEventView } from '../../../shared/requests.ts';
import type { RequestEventType } from '../../../shared/status.ts';
import { useViewer } from '../../hooks/use-viewer.ts';
import { useMediaServerName } from '../../lib/media-server.ts';
import {
  formatDateTime,
  isActiveRequest,
  myRequestsForQuery,
  onBehalfLabel,
  requestArrName,
  requestDetailQuery,
  requestProgress,
  requestStepsOf,
  type StepState,
} from '../../lib/requests.ts';
import { SectionHeading } from '../media/rail.tsx';
import { Button } from '../ui/button.tsx';
import { useEditRequestAction } from './request-sheet.tsx';

type Node = { key: string; title: string; detail?: string; state: StepState };

/** `onServer` : « Dans Plex », dernière étape de la barre. */
const eventTitle = (type: RequestEventType, actor: string | undefined, arr: string, onServer: string): string => {
  const by = actor ? ` par ${actor}` : '';
  const titles: Record<RequestEventType, string> = {
    requested: `Demandée${by}`,
    approved: `Approuvée${by}`,
    declined: `Refusée${by}`,
    cancelled: `Annulée${by}`,
    sent: `Envoyée à ${arr}`,
    failed: `Échec de l’envoi à ${arr}`,
    retried: `Relancée${by}`,
    available: onServer,
  };
  return titles[type];
};

const eventNode = (event: RequestEventView, arr: string, onServer: string, onBehalf: string | null): Node => ({
  key: `event-${event.id}`,
  // La demande elle-même (sans détail : pas un ajout de saisons) faite à la place du membre : « Demandée par X pour Y ».
  // Une modification (évènement `requested` au détail « Demande modifiée : … ») : « Modifiée par X ».
  title:
    event.type === 'requested' && !event.detail && onBehalf
      ? onBehalf
      : event.type === 'requested' && event.detail?.startsWith(REQUEST_EDITED_DETAIL)
        ? `Modifiée${event.actor ? ` par ${event.actor.name}` : ''}`
        : eventTitle(event.type, event.actor?.name, arr, onServer),
  detail: [formatDateTime(event.createdAt), event.detail].filter(Boolean).join(' · '),
  state: event.type === 'failed' || event.type === 'declined' ? 'failed' : 'done',
});

/**
 * Frise : les faits passés, puis, tant que la demande est en cours, l'étape actuelle (mise en avant) et celles à venir,
 * tirées de la même traduction en étapes que la barre de Mes demandes.
 */
function timelineNodes(request: RequestDetail, serverName: string, viewerId: string | undefined): Node[] {
  const onServer = requestStepsOf(serverName)[3];
  const arr = requestArrName(request);
  const onBehalf = onBehalfLabel(request, viewerId);
  const nodes = request.events.map((event) => eventNode(event, arr, onServer, onBehalf));
  const progress = requestProgress(request, serverName);
  if (!isActiveRequest(request.status) || progress.tone === 'available') return nodes;
  const current: Record<typeof request.status, string> = {
    pending: 'Approbation',
    approved: `Envoi à ${arr}`,
    failed: `Nouvel envoi à ${arr}`,
    sent: progress.steps[2] === 'current' ? 'Téléchargement' : 'Recherche d’une source',
  };
  nodes.push({ key: 'current', title: current[request.status], detail: progress.detail, state: 'current' });
  if (progress.steps[2] === 'todo') nodes.push({ key: 'download', title: 'Téléchargement', state: 'todo' });
  nodes.push({ key: 'emby', title: onServer, state: 'todo' });
  return nodes;
}

const dot: Record<StepState, string> = {
  done: 'border-ok bg-ok',
  failed: 'border-danger bg-danger',
  current: 'border-brand bg-background',
  todo: 'border-muted-foreground/60 bg-background',
};

export function RequestTimeline({ request }: { request: RequestDetail }) {
  const serverName = useMediaServerName();
  const viewerId = useViewer()?.id;
  return (
    <ol className="relative space-y-5 pl-7 before:absolute before:top-1.5 before:bottom-1.5 before:left-[7px] before:w-0.5 before:bg-(--track)">
      {timelineNodes(request, serverName, viewerId).map((node) => (
        <li key={node.key} aria-current={node.state === 'current' ? 'step' : undefined} className="relative">
          <span aria-hidden className={cn('absolute top-0.5 -left-7 size-4 rounded-full border-2', dot[node.state])} />
          <span
            className={cn(
              'block text-sm font-semibold',
              node.state === 'todo' && 'text-muted-foreground',
              node.state === 'current' && 'text-(--accent-text)',
            )}
          >
            {node.title}
            {node.state === 'current' && <span className="sr-only"> (étape actuelle)</span>}
          </span>
          {node.detail && <span className="block text-xs text-muted-foreground">{node.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * « Suivi de la demande » de la fiche (maquette R-Fiche) : la dernière demande du membre pour ce titre. Sans demande,
 * pendant le chargement ou en erreur, la section ne s'affiche pas.
 */
export function RequestTracking({ media }: { media: MediaKey }) {
  const allowed = !!useViewer()?.capabilities.canRequest;
  const mine = useQuery({ ...myRequestsForQuery(media), enabled: allowed });
  const latest = mine.data?.results[0];
  const detail = useQuery({ ...requestDetailQuery(latest?.id ?? 0), enabled: !!latest });
  const edit = useEditRequestAction(detail.data);
  if (!latest || !detail.data) return null;
  return (
    <section aria-labelledby="suivi-demande" className="max-w-[560px]">
      <SectionHeading id="suivi-demande">Suivi de la demande</SectionHeading>
      <div className="glass rounded-[16px] p-5 lg:p-6">
        <RequestTimeline request={detail.data} />
        {edit && (
          <Button variant="secondary" size="sm" className="mt-5" onClick={edit}>
            Modifier la demande
          </Button>
        )}
      </div>
    </section>
  );
}
