import { cn } from 'cn';
import type { ReactNode } from 'react';

/** Choix unique en bandeau cliquable de 44 px : radio + contenu (rôle, quotas, membre pour qui demander). */
export function ChoiceRow({
  name,
  checked,
  disabled,
  onSelect,
  className,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-[12px] bg-muted px-3 py-2 text-sm has-checked:ring-2 has-checked:ring-ring has-focus-visible:ring-3 has-focus-visible:ring-ring has-disabled:cursor-not-allowed has-disabled:opacity-60',
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        className="size-4 shrink-0 accent-(--accent-play)"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      {children}
    </label>
  );
}
