import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import type { MediaKey } from '../../../shared/media.ts';
import type { RequestDetail, RequestEventView } from '../../../shared/requests.ts';
import type { RequestEventType } from '../../../shared/status.ts';
import { useViewer } from '../../hooks/use-viewer.ts';
import {
  arrName,
  formatDateTime,
  isActiveRequest,
  latestRequestFor,
  myRequestsQuery,
  requestDetailQuery,
  requestProgress,
  type StepState,
} from '../../lib/requests.ts';
import { SectionHeading } from '../media/rail.tsx';

type Node = { key: string; title: string; detail?: string; state: StepState };

const eventTitle = (type: RequestEventType, actor: string | undefined, arr: string): string => {
  const by = actor ? ` par ${actor}` : '';
  const titles: Record<RequestEventType, string> = {
    requested: `Demandée${by}`,
    approved: `Approuvée${by}`,
    declined: `Refusée${by}`,
    cancelled: `Annulée${by}`,
    sent: `Envoyée à ${arr}`,
    failed: `Échec de l’envoi à ${arr}`,
    retried: `Relancée${by}`,
    available: 'Dans Emby',
  };
  return titles[type];
};

const eventNode = (event: RequestEventView, arr: string): Node => ({
  key: `event-${event.id}`,
  title: eventTitle(event.type, event.actor?.name, arr),
  detail: [formatDateTime(event.createdAt), event.detail].filter(Boolean).join(' · '),
  state: event.type === 'failed' || event.type === 'declined' ? 'failed' : 'done',
});

/**
 * Frise : les faits passés, puis, tant que la demande est en cours, l'étape actuelle (mise en avant) et celles à venir,
 * tirées de la même traduction en étapes que la barre de Mes demandes.
 */
function timelineNodes(request: RequestDetail): Node[] {
  const arr = arrName(request.type);
  const nodes = request.events.map((event) => eventNode(event, arr));
  const progress = requestProgress(request);
  if (!isActiveRequest(request.status) || progress.tone === 'available') return nodes;
  const current: Record<typeof request.status, string> = {
    pending: 'Approbation',
    approved: `Envoi à ${arr}`,
    failed: `Nouvel envoi à ${arr}`,
    sent: progress.steps[2] === 'current' ? 'Téléchargement' : 'Recherche d’une source',
  };
  nodes.push({ key: 'current', title: current[request.status], detail: progress.detail, state: 'current' });
  if (progress.steps[2] === 'todo') nodes.push({ key: 'download', title: 'Téléchargement', state: 'todo' });
  nodes.push({ key: 'emby', title: 'Dans Emby', state: 'todo' });
  return nodes;
}

const dot: Record<StepState, string> = {
  done: 'border-ok bg-ok',
  failed: 'border-danger bg-danger',
  current: 'border-brand bg-background',
  todo: 'border-muted-foreground/60 bg-background',
};

export function RequestTimeline({ request }: { request: RequestDetail }) {
  return (
    <ol className="relative space-y-5 pl-7 before:absolute before:top-1.5 before:bottom-1.5 before:left-[7px] before:w-0.5 before:bg-(--track)">
      {timelineNodes(request).map((node) => (
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
  const mine = useQuery({ ...myRequestsQuery(), enabled: allowed });
  const latest = mine.data ? latestRequestFor(mine.data, media) : undefined;
  const detail = useQuery({ ...requestDetailQuery(latest?.id ?? 0), enabled: !!latest });
  if (!latest || !detail.data) return null;
  return (
    <section aria-labelledby="suivi-demande" className="max-w-[560px]">
      <SectionHeading id="suivi-demande">Suivi de la demande</SectionHeading>
      <div className="glass rounded-[16px] p-5 lg:p-6">
        <RequestTimeline request={detail.data} />
      </div>
    </section>
  );
}
