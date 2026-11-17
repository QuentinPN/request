import { ISSUE_MESSAGE_MAX, type IssueCreateInput, issueTypeLabels, issueTypes } from '@shared/issues.ts';
import type { MediaDetails } from '@shared/media.ts';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Flag, X } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { RequestThumb } from '@/components/requests/request-progress';
import { bottomSheet } from '@/components/requests/request-sheet';
import { roundButton } from '@/components/shell/nav-items';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FieldHint, Input, Label, NativeSelect, Textarea } from '@/components/ui/field';
import { useViewer } from '@/hooks/use-viewer';
import { regularSeasons, seasonTitle, summaryMeta } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { canReport, useCreateIssue } from '@/lib/issues';

/** « Signaler un problème » de la fiche : feuille de saisie, visible pour un titre présent dans la bibliothèque. */
export function ReportIssueButton({ media, className }: { media: MediaDetails; className?: string }) {
  const [open, setOpen] = useState(false);
  // Chaque ouverture repart d'un formulaire neuf (champs, erreur, confirmation).
  const [session, setSession] = useState(0);
  const viewer = useViewer();
  if (!viewer || !canReport(media)) return null;
  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        className={cn('border-input', className)}
        onClick={() => {
          setSession((n) => n + 1);
          setOpen(true);
        }}
      >
        <Flag data-icon="inline-start" />
        Signaler un problème
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className={bottomSheet}>
          <span aria-hidden className="h-[5px] w-10 justify-self-center rounded-full bg-(--track) lg:hidden" />
          <div className="flex items-start gap-4">
            <RequestThumb posterPath={media.posterPath} className="w-12 lg:w-16" />
            <div className="min-w-0 grow space-y-1">
              <DialogTitle className="text-lg font-bold lg:text-[22px]">Signaler un problème</DialogTitle>
              <DialogDescription>{[media.title, ...summaryMeta(media)].join(' · ')}</DialogDescription>
            </div>
            <DialogClose aria-label="Fermer" className={cn(roundButton, 'size-10 shrink-0 max-lg:hidden')}>
              <X aria-hidden className="size-5" />
            </DialogClose>
          </div>
          <ReportForm key={session} media={media} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReportForm({ media, onClose }: { media: MediaDetails; onClose: () => void }) {
  const ids = useId();
  const mutation = useCreateIssue();
  const [type, setType] = useState<IssueCreateInput['type']>('video');
  const [season, setSeason] = useState('');
  const [episode, setEpisode] = useState('');
  const [message, setMessage] = useState('');

  const isTv = media.type === 'tv';
  const seasons = regularSeasons(media.seasons);
  const disabled = message.trim() === '' || mutation.isPending;

  if (mutation.data)
    return (
      <div className="grid gap-5">
        <Notice tone="ok" role="status">
          <strong>Signalement envoyé.</strong> Un gestionnaire sera prévenu ; vous suivrez la réponse dans Signalements.
        </Notice>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link to="/signalements" onClick={onClose} className={buttonVariants({ variant: 'ghost', size: 'lg' })}>
            Mes signalements
          </Link>
          <Button size="lg" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </div>
    );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    mutation.mutate({
      type,
      mediaType: media.type,
      tmdbId: media.tmdbId,
      seasonNumber: isTv && season !== '' ? Number(season) : null,
      episodeNumber: isTv && season !== '' && episode !== '' ? Number(episode) : null,
      message,
    });
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <div>
        <Label htmlFor={`${ids}-type`}>Type de problème</Label>
        <NativeSelect
          id={`${ids}-type`}
          value={type}
          onChange={(e) => setType(e.target.value as IssueCreateInput['type'])}
        >
          {issueTypes.map((value) => (
            <option key={value} value={value}>
              {issueTypeLabels[value]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {isTv && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${ids}-season`}>Saison (facultatif)</Label>
            <NativeSelect
              id={`${ids}-season`}
              value={season}
              onChange={(e) => {
                setSeason(e.target.value);
                if (e.target.value === '') setEpisode('');
              }}
            >
              <option value="">Toute la série</option>
              {seasons.map((s) => (
                <option key={s.seasonNumber} value={s.seasonNumber}>
                  {seasonTitle(s)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor={`${ids}-episode`}>Épisode (facultatif)</Label>
            <Input
              id={`${ids}-episode`}
              type="number"
              inputMode="numeric"
              min={1}
              value={episode}
              disabled={season === ''}
              onChange={(e) => setEpisode(e.target.value)}
            />
          </div>
        </div>
      )}
      <div>
        <Label htmlFor={`${ids}-message`}>Décrivez le problème</Label>
        <Textarea
          id={`${ids}-message`}
          rows={4}
          maxLength={ISSUE_MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-describedby={`${ids}-hint`}
        />
        <FieldHint id={`${ids}-hint`}>Par exemple : les sous-titres sont décalés à partir de la 40e minute.</FieldHint>
      </div>
      {mutation.error && (
        <Notice tone="error" role="alert">
          {errorMessage(mutation.error, 'Le signalement n’a pas pu être envoyé.')}
        </Notice>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose render={<Button variant="ghost" size="lg" />}>Annuler</DialogClose>
        <Button type="submit" size="lg" disabled={disabled}>
          {mutation.isPending ? 'Envoi…' : 'Signaler'}
        </Button>
      </div>
    </form>
  );
}
