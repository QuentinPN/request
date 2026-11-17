import { useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseReason, ReasonField } from './request-parts';

type Props = {
  title: string;
  description: string;
  /** Qui lira le motif, pour l'invite du champ. */
  audience: string;
  busy: boolean;
  /** Échec du serveur au dernier essai : la feuille reste ouverte avec son message. */
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
};

/** Feuille de refus : le motif est obligatoire (refus d'une demande sur mobile, du tableau et refus groupé). */
export function DeclineDialog({ title, description, audience, busy, error, onConfirm, onClose }: Props) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const submit = () => {
    const parsed = parseReason(value);
    setInvalid(parsed.error ?? null);
    if (parsed.reason) onConfirm(parsed.reason);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ReasonField
          value={value}
          onChange={(next) => {
            setValue(next);
            setInvalid(null);
          }}
          error={invalid}
          hint={`Visible par ${audience}`}
          disabled={busy}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            Refuser
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
