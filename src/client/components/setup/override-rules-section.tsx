import type { ArrServer } from '@shared/arr-servers.ts';
import type { MediaType } from '@shared/media.ts';
import type { OverrideRule } from '@shared/override-rules.ts';
import { plural } from '@shared/text.ts';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { ChevronDown, ChevronUp, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { languageLabel } from '@/components/media/browse-filters';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { genresQuery, mediaTypePlural } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { overrideRulesQuery, useReorderOverrideRules, useSaveOverrideRule } from '@/lib/override-rules';
import { IconButton } from './discover-section';
import { OverrideRuleDialog } from './override-rule-dialog';
import { arrServersQuery } from './queries';
import { LoadedSection, SectionFrame, type SectionFrameProps } from './section-frame';

/** « Films · Radarr 4K · Animation, Action · Japonais · anime » : à quoi s'applique la règle, et où elle envoie. */
function ruleSummary(rule: OverrideRule, servers: ArrServer[], genreNames: Map<number, string>) {
  const server = servers.find((s) => s.id === rule.serverId);
  return [
    mediaTypePlural[rule.type],
    server && `${server.name}${server.is4k ? ' (4K)' : ''}`,
    rule.genres.map((id) => genreNames.get(id) ?? `genre ${id}`).join(', '),
    rule.languages.map(languageLabel).join(', '),
    rule.keywords.map((k) => k.name).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

const useGenreNames = (type: MediaType) =>
  new Map((useQuery(genresQuery(type)).data?.genres ?? []).map((g) => [g.id, g.name]));

function RuleItem({
  rule,
  index,
  count,
  summary,
  busy,
  onMove,
  onToggle,
  onEdit,
}: {
  rule: OverrideRule;
  index: number;
  count: number;
  summary: string;
  busy: boolean;
  onMove: (delta: -1 | 1) => void;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className={cn('truncate font-semibold', !rule.enabled && 'text-muted-foreground line-through')}>
          {index + 1}. {rule.name}
        </span>
        <span className="text-xs text-muted-foreground">
          {summary}
          {!rule.enabled && ' · désactivée'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="mr-1 inline-flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-(--accent-play)"
            checked={rule.enabled}
            disabled={busy}
            onChange={onToggle}
          />
          Active
          <span className="sr-only"> : règle {rule.name}</span>
        </label>
        <IconButton label={`Monter ${rule.name}`} disabled={busy || index === 0} onClick={() => onMove(-1)}>
          <ChevronUp />
        </IconButton>
        <IconButton label={`Descendre ${rule.name}`} disabled={busy || index === count - 1} onClick={() => onMove(1)}>
          <ChevronDown />
        </IconButton>
        <IconButton label={`Modifier ${rule.name}`} onClick={onEdit}>
          <Pencil />
        </IconButton>
      </div>
    </li>
  );
}

function RulesEditor({ rules, servers }: { rules: OverrideRule[]; servers: ArrServer[] }) {
  const reorder = useReorderOverrideRules();
  const save = useSaveOverrideRule();
  const [editing, setEditing] = useState<OverrideRule | 'new' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const genreNames = { movie: useGenreNames('movie'), tv: useGenreNames('tv') };
  const busy = reorder.isPending || save.isPending;

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    const ids = rules.map((r) => r.id);
    const [id] = ids.splice(index, 1);
    if (id === undefined || target < 0 || target >= rules.length) return;
    ids.splice(target, 0, id);
    const name = rules[index]?.name;
    reorder.mutate(ids, {
      onSuccess: () => setAnnouncement(`« ${name} » : position ${target + 1} sur ${rules.length}`),
    });
  };
  const toggle = ({ id, position: _position, ...values }: OverrideRule) =>
    save.mutate({ id, rule: { ...values, enabled: !values.enabled } });
  const error = reorder.error ?? save.error;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Selon le genre, la langue originale ou les mots-clés TMDB d’un titre, l’envoyer à un autre serveur, avec un
        autre profil, dossier ou type de série, et des étiquettes en plus. La première règle qui correspond l’emporte,
        champ par champ. Un choix fait sur la demande ou à l’approbation passe avant.
      </p>
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune règle : chaque titre part avec les réglages du serveur.</p>
      ) : (
        <ol aria-label="Règles de surcharge" className="divide-y divide-border border-y border-border">
          {rules.map((rule, index) => (
            <RuleItem
              key={rule.id}
              rule={rule}
              index={index}
              count={rules.length}
              summary={ruleSummary(rule, servers, genreNames[rule.type])}
              busy={busy}
              onMove={(delta) => move(index, delta)}
              onToggle={() => toggle(rule)}
              onEdit={() => setEditing(rule)}
            />
          ))}
        </ol>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {error && (
        <Notice tone="error" role="alert">
          {errorMessage(error, 'Les règles n’ont pas pu être enregistrées.')}
        </Notice>
      )}
      <div>
        <Button type="button" variant="secondary" className="border-input" onClick={() => setEditing('new')}>
          <Plus data-icon="inline-start" />
          Ajouter une règle
        </Button>
      </div>
      {editing && (
        <OverrideRuleDialog
          rule={editing === 'new' ? undefined : editing}
          servers={servers}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Règles de surcharge (propriétaire) : liste ordonnée, ajout, modification et suppression dans une fenêtre. */
export function OverrideRulesSection(frame: SectionFrameProps) {
  const rules = useQuery(overrideRulesQuery);
  const servers = useQuery(arrServersQuery);
  return (
    <LoadedSection
      {...frame}
      // Les deux lectures : la liste des règles, puis les serveurs (noms, effets) ; la première en erreur s'affiche.
      query={servers.isError || (rules.isSuccess && servers.isPending) ? (servers as UseQueryResult<unknown>) : rules}
      errorMessage="Les règles de surcharge n’ont pas pu se charger."
    >
      {() => {
        const list = rules.data ?? [];
        const active = list.filter((r) => r.enabled).length;
        return (
          <SectionFrame
            {...frame}
            status={active > 0 ? 'done' : 'todo'}
            todoLabel="Aucune"
            doneLabel={plural(active, 'règle active', 'règles actives')}
          >
            <RulesEditor rules={list} servers={servers.data ?? []} />
          </SectionFrame>
        );
      }}
    </LoadedSection>
  );
}
