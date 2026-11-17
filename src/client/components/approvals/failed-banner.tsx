import type { RequestView } from '@shared/requests.ts';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { requestTitle } from '@/lib/requests';
import { FailureReason } from './queue-table';

/** Bandeau de l'onglet « En attente » : le premier envoi en échec, à relancer d'un clic (maquette R-Approbations). */
export function FailedBanner({
  failed,
  more,
  busy,
  onRetry,
  onShowAll,
}: {
  failed: RequestView;
  /** Autres envois en échec. */
  more: number;
  busy: boolean;
  onRetry: (id: number) => void;
  onShowAll: () => void;
}) {
  const title = requestTitle(failed);
  return (
    <Notice tone="error" role="alert">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 grow">
          <span className="font-semibold">{title}</span> : <FailureReason request={failed} />
          {more > 0 && (
            <>
              {' '}
              <button type="button" className="underline underline-offset-2" onClick={onShowAll}>
                et {more} autre{more > 1 ? 's' : ''} en échec
              </button>
            </>
          )}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          aria-label={`Réessayer ${title}`}
          onClick={() => onRetry(failed.id)}
        >
          Réessayer
        </Button>
      </div>
    </Notice>
  );
}
