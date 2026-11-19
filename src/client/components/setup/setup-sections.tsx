import { type ArrKind, isArrKind } from '@shared/arr-servers.ts';
import { type MaskedSetting, settingSchemas } from '@shared/settings.ts';
import type { SettingSection, SetupSection, SetupState } from '@shared/setup.ts';
import { type UseQueryResult, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Loading } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useViewer } from '@/hooks/use-viewer';
import { setupStateQuery } from '@/lib/session';
import { AboutSection } from './about-section';
import { ApiKeysSection } from './api-keys-section';
import { ArrServersSection } from './arr-servers-section';
import { BlocklistSection } from './blocklist-section';
import { CacheSection } from './cache-section';
import { type SectionId, sectionOrder } from './config';
import { DiscordSection } from './discord-section';
import { DiscoverSection } from './discover-section';
import { GeneralSection } from './general-section';
import { IntegrationSection } from './integration-section';
import { JobsSection } from './jobs-section';
import { LogsSection } from './logs-section';
import { MembersSection } from './members-section';
import { NtfySection } from './ntfy-section';
import { OutgoingWebhookSection } from './outgoing-webhook-section';
import { OverrideRulesSection } from './override-rules-section';
import { arrServersQuery, settingQuery } from './queries';
import { RulesSection } from './rules-section';
import { SectionFrame, type SectionFrameProps, SectionLoadError } from './section-frame';
import { SeerrImportSection } from './seerr-import-section';
import { SmtpSection } from './smtp-section';
import { TelegramSection } from './telegram-section';
import { TraktSection } from './trakt-section';
import { WebhooksSection } from './webhooks-section';

/** Amorçage : sans propriétaire, seule la section du serveur multimédia est accessible. */
const isReachable = (section: SetupSection, setup: SetupState) => setup.hasOwner || section === 'mediaServer';

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
          <MembersSection section="members" open={open === 'members'} onToggle={() => toggle('members')} />
          <WebhooksSection section="webhooks" open={open === 'webhooks'} onToggle={() => toggle('webhooks')} />
          <SeerrImportSection section="seerr" open={open === 'seerr'} onToggle={() => toggle('seerr')} />
          <DiscordSection section="discord" open={open === 'discord'} onToggle={() => toggle('discord')} />
          <NtfySection section="ntfy" open={open === 'ntfy'} onToggle={() => toggle('ntfy')} />
          <TelegramSection section="telegram" open={open === 'telegram'} onToggle={() => toggle('telegram')} />
          <OutgoingWebhookSection
            section="outgoingWebhook"
            open={open === 'outgoingWebhook'}
            onToggle={() => toggle('outgoingWebhook')}
          />
          <SmtpSection section="smtp" open={open === 'smtp'} onToggle={() => toggle('smtp')} />
          <TraktSection section="trakt" open={open === 'trakt'} onToggle={() => toggle('trakt')} />
          <ApiKeysSection section="api" open={open === 'api'} onToggle={() => toggle('api')} />
          <BlocklistSection section="blocklist" open={open === 'blocklist'} onToggle={() => toggle('blocklist')} />
          <DiscoverSection section="discover" open={open === 'discover'} onToggle={() => toggle('discover')} />
          <JobsSection section="jobs" open={open === 'jobs'} onToggle={() => toggle('jobs')} />
          <CacheSection section="cache" open={open === 'cache'} onToggle={() => toggle('cache')} />
          <LogsSection section="logs" open={open === 'logs'} onToggle={() => toggle('logs')} />
          <GeneralSection section="general" open={open === 'general'} onToggle={() => toggle('general')} />
          <AboutSection section="about" open={open === 'about'} onToggle={() => toggle('about')} />
          <OverrideRulesSection
            section="overrideRules"
            open={open === 'overrideRules'}
            onToggle={() => toggle('overrideRules')}
          />
        </>
      )}
    </div>
  );
}

type ItemProps<S extends SetupSection = SetupSection> = SectionFrameProps<S> & {
  saved: boolean;
  wizard: boolean;
  onSaved: () => void;
};

/** Radarr et Sonarr sont des serveurs (`/api/arr-servers`) ; les autres sections, des réglages. */
function SetupSectionItem(props: ItemProps) {
  const { section } = props;
  return isArrKind(section) ? (
    <ArrSectionItem {...props} section={section} />
  ) : (
    <SettingSectionItem {...props} section={section} />
  );
}

/** Propriétaire seulement : pendant l'amorçage, personne n'est connecté, rien d'enregistré à relire. */
const useCanRead = () => useViewer()?.capabilities.isOwner === true;

function SettingSectionItem({ saved, wizard, onSaved, ...frame }: ItemProps<SettingSection>) {
  const { section } = frame;
  const canRead = useCanRead();
  const query = useQuery({ ...settingQuery(section), enabled: canRead });
  return (
    <Loaded query={query} enabled={canRead} frame={frame} saved={saved}>
      {(data) => {
        const stored = data ?? null;
        const common = { ...frame, saved, wizard, onSaved };
        if (section === 'rules')
          return (
            <RulesSection
              {...common}
              stored={(stored as MaskedSetting<'rules'> | null) ?? settingSchemas.rules.parse({})}
            />
          );
        return (
          <IntegrationSection {...common} service={section} stored={stored as MaskedSetting<typeof section> | null} />
        );
      }}
    </Loaded>
  );
}

function ArrSectionItem({ section, ...props }: ItemProps<ArrKind>) {
  const canRead = useCanRead();
  const query = useQuery({ ...arrServersQuery, enabled: canRead });
  return (
    <Loaded query={query} enabled={canRead} frame={{ ...props, section }} saved={props.saved}>
      {(servers) => <ArrServersSection {...props} section={section} kind={section} servers={servers ?? []} />}
    </Loaded>
  );
}

/** Chargement puis erreur d'une section, avant son formulaire (rien à charger quand `enabled` est faux). */
function Loaded<T>({
  query,
  enabled,
  frame,
  saved,
  children,
}: {
  query: UseQueryResult<T>;
  enabled: boolean;
  frame: SectionFrameProps;
  saved: boolean;
  children: (data: T | undefined) => ReactNode;
}) {
  if (enabled && query.isPending)
    return (
      <SectionFrame {...frame} status={saved ? 'done' : 'todo'}>
        <Loading className="space-y-4">
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
          <Skeleton className="ml-auto h-12 w-48 rounded-(--r-button)" />
        </Loading>
      </SectionFrame>
    );
  if (query.isError) return <SectionLoadError {...frame} query={query} message="Ce réglage n’a pas pu se charger." />;
  return children(enabled ? query.data : undefined);
}
