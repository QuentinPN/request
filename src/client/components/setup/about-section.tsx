import type { About } from '@shared/app-info.ts';
import { requestStatuses } from '@shared/status.ts';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { requestStatusLabel } from '@/lib/requests';
import { formatCount, formatDelay } from '@/lib/stats';
import { formatBytes } from './config';
import { aboutQuery } from './queries';
import { LoadedSection, SectionFrame, type SectionFrameProps } from './section-frame';

const subheading = 'mb-2 text-[13px] font-semibold';

function Row({ label, children, wrap }: { label: string; children: ReactNode; wrap?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="text-[13px] text-muted-foreground sm:w-44 sm:shrink-0">{label}</dt>
      <dd className={wrap ? 'min-w-0 text-sm break-all' : 'min-w-0 text-sm'}>{children}</dd>
    </div>
  );
}

function AboutDetails({ about, ...frame }: SectionFrameProps & { about: About }) {
  const { counts } = about;
  return (
    <SectionFrame {...frame} status="todo" todoLabel="Lecture seule">
      <div className="flex flex-col gap-5">
        <div>
          <h3 className={subheading}>Application</h3>
          <dl className="divide-y divide-border">
            <Row label="Version">{about.version}</Row>
            <Row label="Commit">{about.commit ?? 'inconnu'}</Row>
            <Row label="Node">{about.node}</Row>
            <Row label="En marche depuis">{formatDelay(about.uptimeSeconds)}</Row>
            <Row label="Fuseau horaire">{about.timeZone}</Row>
            <Row label="Dossier de données" wrap>
              {about.dataDir}
            </Row>
            <Row label="Base de données">{formatBytes(about.databaseBytes)}</Row>
          </dl>
        </div>
        <div>
          <h3 className={subheading}>Compteurs</h3>
          <dl className="divide-y divide-border">
            <Row label="Membres">{formatCount(counts.members)}</Row>
            <Row label="Titres suivis">{formatCount(counts.media)}</Row>
            <Row label="Demandes">{formatCount(counts.requests)}</Row>
            {requestStatuses.map((status) => (
              <Row key={status} label={`· ${requestStatusLabel[status]}`}>
                {formatCount(counts.requestsByStatus[status] ?? 0)}
              </Row>
            ))}
          </dl>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Pas de vérification de mise à jour : le dépôt GitHub est privé, sa dernière version n’est pas lisible sans
          compte.
        </p>
      </div>
    </SectionFrame>
  );
}

/** Réglages › À propos (propriétaire) : lecture seule, chargée à l'ouverture de la section. */
export function AboutSection(frame: SectionFrameProps) {
  const query = useQuery(aboutQuery(frame.open));
  return (
    <LoadedSection
      {...frame}
      todoLabel="Lecture seule"
      query={query}
      rows={3}
      errorMessage="Ces informations n’ont pas pu se charger."
    >
      {(about) => <AboutDetails {...frame} about={about} />}
    </LoadedSection>
  );
}
