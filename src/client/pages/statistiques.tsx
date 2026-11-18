import { imageUrl, type MediaType } from '@shared/media.ts';
import { requestStatuses } from '@shared/status.ts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { Avatar } from '@/components/shell/avatar';
import { EmptyState, Loading } from '@/components/states';
import { ChartCard, ChartTable, MonthHistogram, RankedBars, SplitBar } from '@/components/stats/charts';
import { Skeleton } from '@/components/ui/skeleton';
import { useViewer } from '@/hooks/use-viewer';
import { mediaTypeLabel, mediaTypePlural, titleLink } from '@/lib/catalogue';
import { requestStatusLabel } from '@/lib/requests';
import { delaySummary, formatCount, monthName, statsQuery } from '@/lib/stats';

const skeleton = (
  <Loading label="Chargement des statistiques…" className="space-y-6">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe de squelettes identiques
        <Skeleton key={i} className="h-28 rounded-card" />
      ))}
    </div>
    <Skeleton className="h-64 w-full rounded-card" />
  </Loading>
);

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="space-y-1 rounded-card bg-card p-4 ring-1 ring-border sm:p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
    </div>
  );
}

const unnamedTitle = (type: MediaType, tmdbId: number) => `${mediaTypeLabel[type]} n° ${tmdbId}`;

function TitleThumb({ posterPath }: { posterPath: string | null }) {
  const src = imageUrl(posterPath, 'poster');
  return (
    <span
      aria-hidden
      className="block aspect-2/3 w-8 shrink-0 overflow-hidden rounded-sm bg-(--media-base) ring-1 ring-border"
    >
      {src && <img src={src} alt="" loading="lazy" className="size-full object-cover" />}
    </span>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2">{children}</div>;
}

export function StatistiquesPage() {
  const allowed = useViewer()?.capabilities.canViewStats === true;
  const query = useQuery({ ...statsQuery(), enabled: allowed });
  if (!allowed)
    return (
      <Page title="Statistiques">
        <EmptyState title="Accès réservé" description="Les statistiques sont réservées aux gestionnaires." />
      </Page>
    );

  return (
    <Page title="Statistiques">
      <QueryState query={query} skeleton={skeleton} errorMessage="Les statistiques n’ont pas pu être chargées.">
        {(stats) => {
          const approval = delaySummary(stats.delays.approval);
          const availability = delaySummary(stats.delays.availability);
          const { requests } = stats;
          const monthRows = requests.byMonth.map((m) => ({ label: monthName(m.month, 'long'), value: m.count }));
          const statusRows = requestStatuses.map((s) => ({
            label: requestStatusLabel[s],
            value: requests.byStatus[s],
          }));
          const typeRows = [
            { label: mediaTypePlural.movie, value: requests.byType.movie ?? 0 },
            { label: mediaTypePlural.tv, value: requests.byType.tv ?? 0 },
          ] as const;
          const qualityRows = [
            { label: 'Qualité normale', value: requests.byQuality.standard },
            { label: '4K', value: requests.byQuality.fourK },
          ] as const;
          const titleRows = stats.topTitles.map((t) => ({
            label: t.title ?? unnamedTitle(t.type, t.tmdbId),
            value: t.count,
          }));
          const memberRows = stats.topMembers.map((m) => ({ label: m.name, value: m.count }));

          return (
            <div className="space-y-6">
              <section aria-label="Chiffres clés" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <Tile label="Demandes" value={formatCount(requests.total)} />
                <Tile label="Membres" value={formatCount(stats.members)} />
                <Tile
                  label="Signalements ouverts"
                  value={formatCount(stats.issues.open)}
                  detail={`${formatCount(stats.issues.resolved)} résolu${stats.issues.resolved > 1 ? 's' : ''}`}
                />
                <Tile label="Délai d’approbation" value={approval.value} detail={approval.detail} />
                <Tile label="Délai de mise à disposition" value={availability.value} detail={availability.detail} />
                <Tile
                  label="Listes de souhaits"
                  value={formatCount(stats.watchlist.titles)}
                  detail={`titre${stats.watchlist.titles > 1 ? 's' : ''} · ${formatCount(stats.watchlist.entries)} ajout${stats.watchlist.entries > 1 ? 's' : ''}`}
                />
              </section>

              <ChartCard title="Demandes par mois" description="Les 12 derniers mois, le mois en cours compris.">
                <MonthHistogram months={requests.byMonth} />
                <ChartTable caption="Demandes par mois" head={['Mois', 'Demandes']} rows={monthRows} />
              </ChartCard>

              <Section>
                <ChartCard title="Demandes par statut" description="Toutes les demandes depuis le début.">
                  <RankedBars
                    label="Demandes par statut"
                    empty="Aucune demande pour l’instant."
                    rows={statusRows.map((r) => ({ key: r.label, label: r.label, value: r.value }))}
                  />
                  <ChartTable caption="Demandes par statut" head={['Statut', 'Demandes']} rows={statusRows} />
                </ChartCard>
                <div className="space-y-4">
                  <ChartCard title="Films et séries">
                    <SplitBar parts={[typeRows[0], typeRows[1]]} />
                    <ChartTable caption="Films et séries" head={['Type', 'Demandes']} rows={[...typeRows]} />
                  </ChartCard>
                  <ChartCard title="Qualité demandée">
                    <SplitBar parts={[qualityRows[0], qualityRows[1]]} />
                    <ChartTable caption="Qualité demandée" head={['Qualité', 'Demandes']} rows={[...qualityRows]} />
                  </ChartCard>
                </div>
              </Section>

              <Section>
                <ChartCard title="Membres les plus actifs" description="Nombre de demandes par membre.">
                  <RankedBars
                    label="Membres les plus actifs"
                    empty="Aucun membre n’a encore fait de demande."
                    rows={stats.topMembers.map((m) => ({
                      key: m.id,
                      label: m.name,
                      value: m.count,
                      lead: <Avatar viewer={m} className="size-8" />,
                    }))}
                  />
                  <ChartTable caption="Membres les plus actifs" head={['Membre', 'Demandes']} rows={memberRows} />
                </ChartCard>
                <ChartCard title="Titres les plus demandés" description="Nombre de demandes par titre.">
                  <RankedBars
                    label="Titres les plus demandés"
                    empty="Aucun titre n’a encore été demandé."
                    rows={stats.topTitles.map((t) => ({
                      key: `${t.type}:${t.tmdbId}`,
                      label: (
                        <Link
                          {...titleLink(t)}
                          className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
                        >
                          {t.title ?? unnamedTitle(t.type, t.tmdbId)}
                          {t.year ? <span className="text-muted-foreground"> ({t.year})</span> : null}
                        </Link>
                      ),
                      value: t.count,
                      lead: <TitleThumb posterPath={t.posterPath} />,
                    }))}
                  />
                  <ChartTable caption="Titres les plus demandés" head={['Titre', 'Demandes']} rows={titleRows} />
                </ChartCard>
              </Section>
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
