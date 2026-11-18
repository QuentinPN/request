import { type AdjustableJobId, isAdjustableJob, type JobInfo, type JobRunStatus } from '@shared/jobs.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import {
  formatInterval,
  formatRunDuration,
  invalidateMaintenance,
  JOBS_POLL_MS,
  jobsQuery,
  runJob,
  setJobInterval,
} from '@/lib/maintenance';
import { formatDateTime } from '@/lib/requests';
import { LoadedSection, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

const runLabels: Record<JobRunStatus, string> = { running: 'En cours', success: 'Réussie', failed: 'En échec' };

/** Fréquence réglée en heures quand les bornes tombent sur des heures pleines (balayage complet), sinon en minutes. */
const inHours = (job: JobInfo) => job.bounds !== null && job.bounds.min % 60 === 0;

function FrequencyForm({ job, jobId }: { job: JobInfo; jobId: AdjustableJobId }) {
  const id = useId();
  const queryClient = useQueryClient();
  const { bounds, intervalMinutes } = job;
  const factor = inHours(job) ? 60 : 1;
  const unit = factor === 60 ? 'heures' : 'minutes';
  const [value, setValue] = useState(String((intervalMinutes ?? 0) / factor));
  const minutes = Number(value) * factor;
  const valid =
    value.trim() !== '' &&
    bounds !== null &&
    Number.isInteger(minutes) &&
    minutes >= bounds.min &&
    minutes <= bounds.max;
  const save = useMutation({
    mutationFn: () => setJobInterval(jobId, minutes),
    onSuccess: () => invalidateMaintenance(queryClient),
  });
  if (bounds === null) return null;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && minutes !== intervalMinutes) save.mutate();
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
      <Label htmlFor={`${id}-interval`} className="mb-0">
        Fréquence ({unit})
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={`${id}-interval`}
          type="number"
          inputMode="numeric"
          min={bounds.min / factor}
          max={bounds.max / factor}
          value={value}
          aria-invalid={!valid}
          onChange={(e) => {
            setValue(e.target.value);
            save.reset();
          }}
          className="sm:w-32"
        />
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          className="border-input text-[15px]"
          disabled={!valid || minutes === intervalMinutes || save.isPending}
        >
          {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
      </div>
      <FieldHint className="mt-0">
        De {bounds.min / factor} à {bounds.max / factor} {unit}, appliquée sans redémarrage.
      </FieldHint>
      {save.isError && <Notice tone="error">{save.error.message}</Notice>}
    </form>
  );
}

function JobRow({ job }: { job: JobInfo }) {
  const queryClient = useQueryClient();
  const run = useMutation({ mutationFn: () => runJob(job.id), onSettled: () => invalidateMaintenance(queryClient) });
  const { lastRun } = job;
  const status = lastRun?.status;

  return (
    <li className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex min-w-0 grow flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{job.label}</span>
            {status && <Badge variant={status === 'failed' ? 'destructive' : 'secondary'}>{runLabels[status]}</Badge>}
            {!job.enabled && <Badge variant="secondary">Désactivée</Badge>}
          </span>
          <span className="text-sm text-muted-foreground">{job.description}</span>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
            <dt className="text-muted-foreground">Fréquence</dt>
            <dd>{job.intervalMinutes === null ? 'Une fois par jour' : formatInterval(job.intervalMinutes)}</dd>
            <dt className="text-muted-foreground">Dernière</dt>
            <dd>
              {lastRun
                ? `${formatDateTime(lastRun.startedAt)}${lastRun.durationMs === null ? '' : ` · ${formatRunDuration(lastRun.durationMs)}`}`
                : 'Jamais exécutée'}
            </dd>
            {lastRun?.detail && (
              <>
                <dt className="text-muted-foreground">Résultat</dt>
                <dd className="min-w-0 break-words">{lastRun.detail}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Prochaine</dt>
            <dd>
              {!job.enabled
                ? 'Aucune (BACKUP_KEEP=0)'
                : job.nextRunAt
                  ? formatDateTime(job.nextRunAt)
                  : 'Non planifiée'}
            </dd>
          </dl>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="border-input sm:shrink-0"
          aria-label={job.running ? `${job.label} : en cours` : `Lancer maintenant : ${job.label}`}
          disabled={!job.enabled || job.running || run.isPending}
          onClick={() => run.mutate()}
        >
          {job.running ? 'En cours…' : 'Lancer maintenant'}
        </Button>
      </div>
      {run.isError && <Notice tone="error">{run.error.message}</Notice>}
      {isAdjustableJob(job.id) && <FrequencyForm key={job.intervalMinutes} job={job} jobId={job.id} />}
    </li>
  );
}

/**
 * Tâches planifiées (propriétaire) : dernière exécution lue dans `job_runs`, prochaine exécution, lancement immédiat
 * (refusé par le serveur si la tâche tourne déjà) et fréquence réglable des balayages. Pas un réglage de l'assistant.
 */
export function JobsSection(frame: SectionFrameProps) {
  const query = useQuery({
    ...jobsQuery,
    refetchInterval: (q) => (q.state.data?.some((job) => job.running) ? JOBS_POLL_MS : false),
  });
  return (
    <LoadedSection {...frame} query={query} rows={3} errorMessage="Les tâches n’ont pas pu se charger.">
      {(jobs) => {
        const failed = jobs.some((job) => job.lastRun?.status === 'failed');
        const status = sectionStatus({ saved: true, open: frame.open, failed, testing: jobs.some((j) => j.running) });
        return (
          <SectionFrame {...frame} status={status} doneLabel="Actives">
            <ul className="divide-y divide-border">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          </SectionFrame>
        );
      }}
    </LoadedSection>
  );
}
