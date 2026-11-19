import type { RequestView } from '@shared/requests.ts';
import { cn } from 'cn';
import { type ReactNode, useState } from 'react';
import { Notice } from '@/components/notice';
import { SendChoiceFields } from '@/components/requests/send-choice-fields';
import { Button } from '@/components/ui/button';
import { CheckboxRow } from '@/components/ui/field';
import {
  type ApprovalTab,
  profileName,
  requestSendChoice,
  type SendChoice,
  type SendOptions,
  shownSendChoice,
} from '@/lib/approvals';
import { arrName, formatWhen, requestArrName, requestMeta, requestStatusLabel, requestTitle } from '@/lib/requests';
import { approveClass, parseReason, ReasonField, Requester, RequestPoster } from './request-parts';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/**
 * Serveur, profil, dossier et type de série d'envoi : listes du service, pré-remplies avec le choix enregistré sur la
 * demande ; réglages par défaut tant qu'elles ne sont pas connues.
 */
function SendTo({
  request,
  options,
  choice,
  onChoice,
  disabled,
}: {
  request: RequestView;
  options: SendOptions | null | undefined;
  choice: SendChoice;
  onChoice: (patch: SendChoice) => void;
  disabled: boolean;
}) {
  if (!options)
    return (
      <p className="text-sm text-muted-foreground">
        Envoi à {requestArrName(request)} avec le profil et le dossier par défaut des réglages.
      </p>
    );
  return (
    <SendChoiceFields
      service={arrName(request.type, request.is4k)}
      options={options}
      value={shownSendChoice(options, [choice, requestSendChoice(request)])}
      onChoice={onChoice}
      disabled={disabled}
    />
  );
}

type Props = {
  tab: ApprovalTab;
  request: RequestView;
  options: SendOptions | null | undefined;
  /** Listes d'un autre serveur en cours de lecture : celles affichées sont celles du serveur précédent. */
  optionsLoading?: boolean;
  choice: SendChoice;
  onChoice: (patch: SendChoice) => void;
  busy: boolean;
  onApprove: () => void;
  onRetry: () => void;
  onDecline: (reason: string) => void;
};

/** Panneau de droite (ordinateur) : la demande choisie dans le tableau, avec ce qu'on peut en faire selon l'onglet. */
export function DetailPanel({
  tab,
  request,
  options,
  optionsLoading = false,
  choice,
  onChoice,
  busy,
  onApprove,
  onRetry,
  onDecline,
}: Props) {
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const decidable = tab === 'pending' || tab === 'failed';

  const decline = () => {
    const parsed = parseReason(reason);
    setInvalid(parsed.error ?? null);
    if (parsed.reason) onDecline(parsed.reason);
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        <RequestPoster media={request.media} size="sm" />
        <div className="min-w-0 space-y-1.5">
          <h2 className="text-xl font-semibold tracking-tight">{requestTitle(request)}</h2>
          <p className="text-sm text-muted-foreground">{requestMeta(request).join(' · ')}</p>
          <p className="text-sm text-muted-foreground">Demandé {formatWhen(request.createdAt)}</p>
        </div>
      </div>

      <dl className="space-y-2.5">
        <Fact label="Demandé par">
          <Requester request={request} />
        </Fact>
        {request.server && <Fact label="Serveur">{request.server.name}</Fact>}
        {tab === 'history' && (
          <>
            <Fact label="Statut">{requestStatusLabel[request.status]}</Fact>
            {request.decidedBy && <Fact label="Décidé par">{request.decidedBy.name}</Fact>}
            {request.qualityProfileId !== null && (
              <Fact label="Profil">{profileName(options, request.qualityProfileId)}</Fact>
            )}
            {request.rootFolder && <Fact label="Dossier">{request.rootFolder}</Fact>}
          </>
        )}
      </dl>

      {request.media?.overview && (
        <p className="line-clamp-5 text-sm leading-relaxed text-muted-foreground">{request.media.overview}</p>
      )}

      {tab === 'history' && request.declineReason && (
        <Notice tone="info">
          <span className="font-semibold">Motif du refus.</span> {request.declineReason}
        </Notice>
      )}

      {tab === 'failed' && (
        <Notice tone="error">
          {requestArrName(request)} n’a pas pu recevoir cette demande
          {request.failureReason ? ` : ${request.failureReason}` : '.'}
        </Notice>
      )}

      {tab === 'pending' && (
        <SendTo
          request={request}
          options={options}
          choice={choice}
          onChoice={onChoice}
          disabled={busy || optionsLoading}
        />
      )}

      {tab === 'pending' && (
        <CheckboxRow
          checked={choice.quotaExempt ?? request.quotaExempt}
          onChange={(quotaExempt) => onChoice({ quotaExempt })}
          label="Hors quota"
          hint={`Ne compte pas dans le quota de ${request.requester.name}.`}
          disabled={busy}
        />
      )}

      {decidable && (
        <ReasonField
          value={reason}
          onChange={(value) => {
            setReason(value);
            setInvalid(null);
          }}
          error={invalid}
          hint={`Visible par ${request.requester.name}`}
          disabled={busy}
        />
      )}

      {decidable && (
        <div className="flex gap-3">
          <Button variant="secondary" size="lg" className="grow" disabled={busy} onClick={decline}>
            Refuser
          </Button>
          {tab === 'pending' ? (
            <Button
              size="lg"
              variant="outline"
              className={cn('grow', approveClass)}
              disabled={busy}
              onClick={onApprove}
            >
              Approuver et envoyer
            </Button>
          ) : (
            <Button size="lg" variant="outline" className={cn('grow', approveClass)} disabled={busy} onClick={onRetry}>
              Réessayer l’envoi
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
