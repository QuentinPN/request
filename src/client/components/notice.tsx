import { cn } from 'cn';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ComponentProps } from 'react';

// Message teinté de la maquette (request.css, .msg) : résultat d'un test, erreur du serveur, consigne.
const tones = {
  ok: { icon: CircleCheck, className: 'border-(--tint-ok-border) bg-(--tint-ok-bg) text-(--text-ok)' },
  error: { icon: CircleAlert, className: 'border-(--tint-danger-border) bg-(--tint-danger-bg) text-(--text-danger)' },
  info: { icon: Info, className: 'border-(--tint-accent-border) bg-(--tint-accent-bg) text-foreground' },
} as const;

export function Notice({ tone, children, className, ...props }: ComponentProps<'div'> & { tone: keyof typeof tones }) {
  const { icon: Icon, className: toneClass } = tones[tone];
  return (
    <div
      className={cn('flex items-start gap-2.5 rounded-[14px] border px-3.5 py-3 text-sm', toneClass, className)}
      {...props}
    >
      <Icon aria-hidden className="mt-px size-4 shrink-0" />
      <div className="min-w-0 grow">{children}</div>
    </div>
  );
}
