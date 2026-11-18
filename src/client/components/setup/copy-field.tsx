import { Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';

/** Le presse-papiers n'existe qu'en contexte sécurisé (https ou localhost) : sur le réseau local en http, on se rabat sur la sélection. */
const canCopy = () => typeof navigator !== 'undefined' && navigator.clipboard !== undefined;

/** Valeur en lecture seule (adresse, clé) à copier : bouton « Copier » si le navigateur le permet, sinon texte sélectionnable. */
export function CopyField({ label, copyLabel, value }: { label: string; copyLabel: string; value: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Refusé par le navigateur : la valeur reste sélectionnable dans le champ.
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
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 font-mono text-[13px]"
        />
        {canCopy() && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="shrink-0 border-input"
            aria-label={copyLabel}
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
