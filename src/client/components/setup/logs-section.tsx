import { LOG_SEARCH_MAX_LENGTH, type LogEntry, type LogLevel, logLevels } from '@shared/logs.ts';
import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { ErrorState } from '@/components/states';
import { CheckboxField, Input, Label, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { LOGS_POLL_MS, logsQuery } from '@/lib/maintenance';
import { formatCount } from '@/lib/stats';
import { SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

/** « Tous » = dès `debug` ; les autres choix sont le niveau minimal affiché. */
const levelChoices: Record<LogLevel, string> = {
  debug: 'Tous les niveaux',
  info: 'Informations et plus',
  warn: 'Avertissements et erreurs',
  error: 'Erreurs seulement',
};

const levelNames: Record<LogLevel, string> = { debug: 'Détail', info: 'Info', warn: 'Avertissement', error: 'Erreur' };

const levelStyle: Record<LogLevel, string> = {
  debug: 'bg-(--surface-2) text-muted-foreground',
  info: 'bg-(--tint-accent-bg) text-foreground',
  warn: 'bg-(--tint-warn-bg-strong) text-(--text-warn)',
  error: 'bg-(--tint-danger-bg) text-(--text-danger)',
};

const timeFormat = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function EntryRow({ entry }: { entry: LogEntry }) {
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <time dateTime={entry.time} className="text-xs text-muted-foreground tabular-nums">
          {timeFormat.format(new Date(entry.time))}
        </time>
        <span className={cn('rounded-pill px-2 py-0.5 text-xs font-semibold', levelStyle[entry.level])}>
          {levelNames[entry.level]}
        </span>
      </div>
      <p className="text-sm break-words">{entry.message || '—'}</p>
      {entry.context && (
        <p className="max-h-24 overflow-y-auto font-mono text-xs break-all text-muted-foreground">{entry.context}</p>
      )}
    </li>
  );
}

/** Journaux récents du serveur (propriétaire) : gardés en mémoire, les plus récents d'abord, secrets déjà expurgés. */
export function LogsSection(frame: SectionFrameProps) {
  const id = useId();
  const [level, setLevel] = useState<LogLevel>('debug');
  const [text, setText] = useState('');
  const [auto, setAuto] = useState(false);
  const q = useDebouncedValue(text.trim(), 300);
  const query = useQuery({
    ...logsQuery({ level, q }),
    // Lu seulement section ouverte ; actualisé toutes les 5 s si demandé.
    enabled: frame.open,
    refetchInterval: auto ? LOGS_POLL_MS : false,
    placeholderData: (previous) => previous,
  });
  const status = sectionStatus({ saved: true, open: frame.open, failed: query.isError, testing: false });
  const data = query.data;

  return (
    <SectionFrame {...frame} status={status} doneLabel="En mémoire">
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
          <div>
            <Label htmlFor={`${id}-level`}>Niveau</Label>
            <NativeSelect id={`${id}-level`} value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
              {logLevels.map((value) => (
                <option key={value} value={value}>
                  {levelChoices[value]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor={`${id}-q`}>Recherche</Label>
            <Input
              id={`${id}-q`}
              type="search"
              value={text}
              maxLength={LOG_SEARCH_MAX_LENGTH}
              placeholder="Radarr, webhook, 401…"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CheckboxField checked={auto} onChange={(e) => setAuto(e.target.checked)}>
            Actualiser automatiquement (5 s)
          </CheckboxField>
          {data && (
            <p role="status" className="text-sm text-muted-foreground">
              {data.entries.length < data.matching
                ? `${formatCount(data.entries.length)} entrées affichées sur ${formatCount(data.matching)}`
                : `${formatCount(data.matching)} ${data.matching > 1 ? 'entrées' : 'entrée'}`}
            </p>
          )}
        </div>
        {query.isError && !data && (
          <ErrorState message="Les journaux n’ont pas pu se charger." onRetry={() => void query.refetch()} />
        )}
        {query.isPending && frame.open && <Skeleton className="h-24 w-full rounded-(--r-button)" />}
        {data && data.entries.length === 0 && (
          <p className="rounded-(--r-button) bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
            Aucune entrée ne correspond.
          </p>
        )}
        {data && data.entries.length > 0 && (
          <ul
            aria-label="Journaux"
            className="max-h-[32rem] divide-y divide-border overflow-y-auto border-y border-border"
          >
            {data.entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Les 1 000 dernières entrées sont gardées en mémoire et disparaissent au redémarrage. Les jetons, clés d’API et
          cookies sont masqués avant d’être gardés.
        </p>
      </div>
    </SectionFrame>
  );
}
