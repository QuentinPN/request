import { WEBHOOK_TOKEN_PATH, type WebhookService, type WebhookSettings, webhookServices } from '@shared/webhooks.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { apiSend } from '@/lib/http';
import { webhookLabels } from './config';
import { webhooksQuery } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

/** Le presse-papiers n'existe qu'en contexte sécurisé (https ou localhost) : sur le réseau local en http, on se rabat sur la sélection. */
const canCopy = () => typeof navigator !== 'undefined' && navigator.clipboard !== undefined;

function UrlRow({ service, url }: { service: WebhookService; url: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const label = webhookLabels[service];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Refusé par le navigateur : l'adresse reste sélectionnable dans le champ.
    }
  };

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          spellCheck={false}
          autoComplete="off"
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 font-mono text-[13px]"
        />
        {canCopy() && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="shrink-0 border-input"
            aria-label={`Copier l’adresse ${label}`}
            onClick={() => void copy()}
          >
            <Copy data-icon="inline-start" />
            {copied ? 'Copié' : 'Copier'}
          </Button>
        )}
      </div>
    </div>
  );
}

function RegenerateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const regenerate = useMutation({
    mutationFn: () => apiSend<WebhookSettings>('POST', WEBHOOK_TOKEN_PATH),
    onSuccess: (settings) => {
      queryClient.setQueryData(webhooksQuery.queryKey, settings);
      onDone();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !regenerate.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Régénérer le jeton ?</DialogTitle>
          <DialogDescription>
            Les adresses actuelles cessent de fonctionner tout de suite : il faudra coller les nouvelles dans Radarr et
            Sonarr.
          </DialogDescription>
        </DialogHeader>
        {regenerate.isError && <Notice tone="error">{regenerate.error.message}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={regenerate.isPending}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
            {regenerate.isPending ? 'Régénération…' : 'Régénérer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Webhooks entrants de Radarr et Sonarr (propriétaire) : adresses à coller dans leurs connexions, jeton régénérable.
 * Pas un réglage de l'assistant : rien à tester ni à enregistrer, le serveur crée le jeton à la première lecture.
 */
export function WebhooksSection(frame: SectionFrameProps) {
  const query = useQuery(webhooksQuery);
  const [confirming, setConfirming] = useState(false);
  const [regenerated, setRegenerated] = useState(false);

  if (query.isPending)
    return (
      <SectionFrame {...frame} status="todo">
        <div role="status" className="space-y-4">
          <span className="sr-only">Chargement…</span>
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
        </div>
      </SectionFrame>
    );
  if (query.isError)
    return (
      <SectionFrame {...frame} status="error">
        <ErrorState message="Les webhooks n’ont pas pu se charger." onRetry={() => void query.refetch()} />
      </SectionFrame>
    );

  const status = sectionStatus({ saved: true, open: frame.open, failed: false, testing: false });
  return (
    <SectionFrame {...frame} status={status} doneLabel="Actif">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Dans Radarr et Sonarr : Paramètres › Connexions › + › Webhook. Collez l’adresse dans « URL », choisissez la
          méthode <strong className="font-semibold text-foreground">POST</strong>, puis cochez les évènements de
          récupération (Grab), d’import (Download) et de suppression. Radarr et Sonarr doivent pouvoir joindre cette
          adresse : sur Docker, « localhost » ne convient pas.
        </p>
        {webhookServices.map((service) => (
          <UrlRow key={service} service={service} url={query.data.urls[service]} />
        ))}
        <div role="status" className="empty:hidden">
          {regenerated && (
            <Notice tone="ok">Nouveau jeton généré : collez les nouvelles adresses dans Radarr et Sonarr.</Notice>
          )}
        </div>
        <SectionActions>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className={actionClass}
            onClick={() => {
              setRegenerated(false);
              setConfirming(true);
            }}
          >
            Régénérer le jeton
          </Button>
        </SectionActions>
      </div>
      {confirming && (
        <RegenerateDialog
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            setRegenerated(true);
          }}
        />
      )}
    </SectionFrame>
  );
}
