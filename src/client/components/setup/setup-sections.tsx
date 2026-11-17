import { type IntegrationKey, type MaskedSetting, settingSchemas } from '@shared/settings.ts';
import type { SetupSection, SetupState } from '@shared/setup.ts';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useViewer } from '@/hooks/use-viewer';
import { setupStateQuery } from '@/lib/session';
import { ApiKeysSection } from './api-keys-section';
import { type SectionId, sectionOrder } from './config';
import { DiscordSection } from './discord-section';
import { IntegrationSection } from './integration-section';
import { settingQuery } from './queries';
import { RulesSection } from './rules-section';
import { SectionFrame, type SectionFrameProps } from './section-frame';
import { SeerrImportSection } from './seerr-import-section';
import { WebhooksSection } from './webhooks-section';

/** Amorçage : sans propriétaire, seule la section Emby est accessible. */
const isReachable = (section: SetupSection, setup: SetupState) => setup.hasOwner || section === 'emby';

/** Première section accessible encore à faire, à partir de `from` (incluse), sinon depuis le début. */
function nextTodo(setup: SetupState, from = 0): SetupSection | null {
  const todo = (s: SetupSection) => !setup.services[s] && isReachable(s, setup);
  return sectionOrder.slice(from).find(todo) ?? sectionOrder.find(todo) ?? null;
}

/**
 * Les cinq sections de l'assistant, en accordéon. Mêmes composants pour l'assistant (`wizard` : l'enregistrement
 * ouvre la section suivante à faire) et pour les réglages (chaque section s'enregistre et reste ouverte ; le
 * propriétaire y trouve aussi les webhooks et l'import des demandes de Seerr).
 */
export function SetupSections({ wizard }: { wizard: boolean }) {
  const queryClient = useQueryClient();
  const { data: setup } = useSuspenseQuery(setupStateQuery);
  const viewer = useViewer();
  const [open, setOpen] = useState<SectionId | null>(() => (wizard ? nextTodo(setup) : null));
  const toggle = (section: SectionId) => setOpen((current) => (current === section ? null : section));

  const onSaved = (section: SetupSection) => {
    if (!wizard) return;
    const fresh = queryClient.getQueryData(setupStateQuery.queryKey) ?? setup;
    setOpen(nextTodo(fresh, sectionOrder.indexOf(section) + 1));
  };

  return (
    <div className="flex flex-col gap-4">
      {sectionOrder.map((section) => (
        <SetupSectionItem
          key={section}
          section={section}
          saved={setup.services[section]}
          wizard={wizard}
          open={open === section}
          disabled={!isReachable(section, setup)}
          onToggle={() => toggle(section)}
          onSaved={() => onSaved(section)}
        />
      ))}
      {!wizard && viewer?.capabilities.isOwner && (
        <>
          <WebhooksSection section="webhooks" open={open === 'webhooks'} onToggle={() => toggle('webhooks')} />
          <SeerrImportSection section="seerr" open={open === 'seerr'} onToggle={() => toggle('seerr')} />
          <DiscordSection section="discord" open={open === 'discord'} onToggle={() => toggle('discord')} />
          <ApiKeysSection section="api" open={open === 'api'} onToggle={() => toggle('api')} />
        </>
      )}
    </div>
  );
}

type ItemProps = SectionFrameProps<SetupSection> & { saved: boolean; wizard: boolean; onSaved: () => void };

/** Charge le réglage enregistré (propriétaire seulement) puis affiche le formulaire de la section. */
function SetupSectionItem({ saved, wizard, onSaved, ...frame }: ItemProps) {
  const { section } = frame;
  const viewer = useViewer();
  // Pendant l'amorçage, personne n'est connecté : rien d'enregistré à relire, le formulaire part vide.
  const canRead = viewer?.capabilities.isOwner === true;
  const query = useQuery({ ...settingQuery(section), enabled: canRead });

  if (canRead && query.isPending)
    return (
      <SectionFrame {...frame} status={saved ? 'done' : 'todo'}>
        <div role="status" className="space-y-4">
          <span className="sr-only">Chargement…</span>
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
          <Skeleton className="ml-auto h-12 w-48 rounded-(--r-button)" />
        </div>
      </SectionFrame>
    );
  if (query.isError)
    return (
      <SectionFrame {...frame} status="error">
        <ErrorState message="Ce réglage n’a pas pu se charger." onRetry={() => void query.refetch()} />
      </SectionFrame>
    );

  const stored = canRead ? (query.data ?? null) : null;
  const common = { ...frame, saved, wizard, onSaved };
  if (section === 'rules')
    return (
      <RulesSection {...common} stored={(stored as MaskedSetting<'rules'> | null) ?? settingSchemas.rules.parse({})} />
    );
  return <IntegrationSection {...common} service={section} stored={stored as MaskedSetting<IntegrationKey> | null} />;
}
