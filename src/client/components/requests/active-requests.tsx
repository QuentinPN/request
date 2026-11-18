import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { titleLink } from '@/lib/catalogue';
import { useViewer } from '../../hooks/use-viewer.ts';
import { useMediaServerName } from '../../lib/media-server.ts';
import { myActiveRequestsQuery, requestCountsQuery, requestProgress, requestShortTitle } from '../../lib/requests.ts';
import { SectionHeading } from '../media/rail.tsx';
import { RequestStatusPill, RequestStepBar, RequestThumb } from './request-progress.tsx';

/** Cartes affichées au plus ; la suite est dans Mes demandes. */
const STRIP_MAX = 3;

/**
 * « Vos demandes en cours » de Découvrir (maquette R-Decouvrir) : n'apparaît que si le membre a une demande en cours.
 * Chargement ou erreur : rien, les rangées remontent.
 */
export function ActiveRequestsStrip() {
  const allowed = !!useViewer()?.capabilities.canRequest;
  const counts = useQuery({ ...requestCountsQuery(), enabled: allowed });
  const mine = useQuery({ ...myActiveRequestsQuery(), enabled: allowed && (counts.data?.mineActive ?? 0) > 0 });
  const active = (mine.data?.results ?? []).slice(0, STRIP_MAX);
  const serverName = useMediaServerName();
  if (!allowed || counts.data?.mineActive === 0 || active.length === 0) return null;
  return (
    <section aria-labelledby="demandes-en-cours">
      <SectionHeading
        id="demandes-en-cours"
        aside={
          <Link to="/demandes" className="text-sm font-semibold text-(--accent-text) hover:underline">
            Mes demandes
          </Link>
        }
      >
        Vos demandes en cours
      </SectionHeading>
      <ul className="-mx-(--space-page) flex gap-3 overflow-x-auto px-(--space-page) pb-1 [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible lg:px-0">
        {active.map((request) => {
          const progress = requestProgress(request, serverName);
          return (
            <li key={request.id} className="glass flex w-[270px] shrink-0 gap-4 rounded-[16px] p-3 lg:w-auto lg:p-4">
              <RequestThumb posterPath={request.media?.posterPath} className="hidden w-14 lg:block" />
              <div className="min-w-0 grow space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    {...titleLink(request)}
                    className="truncate text-sm font-semibold outline-none hover:underline focus-visible:underline"
                  >
                    {requestShortTitle(request)}
                  </Link>
                  <RequestStatusPill progress={progress} className="shrink-0" />
                </div>
                <RequestStepBar progress={progress} labels />
                <p className="truncate text-xs">{progress.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
