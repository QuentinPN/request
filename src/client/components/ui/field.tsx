import { cn } from 'cn';
import { ChevronDown } from 'lucide-react';
import type * as React from 'react';

// Champs de la maquette (request.css : .lbl, .inp, .hint), partagés par la connexion, l'assistant et les réglages.

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: le champ est relié par htmlFor à l'appel
  return <label className={cn('mb-2 block text-[13px] font-semibold text-foreground', className)} {...props} />;
}

export function FieldHint({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('mt-1.5 text-[13px] text-muted-foreground', className)} {...props} />;
}

export const inputClass =
  'h-12 w-full rounded-(--r-button) border border-input bg-(--field-bg) px-3.5 text-[15px] text-foreground transition-[border-color,box-shadow] duration-(--dur) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/20 disabled:opacity-50 aria-invalid:border-(--tint-danger-border)';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(inputClass, className)} {...props} />;
}

/** Liste déroulante native (clavier et lecteurs d'écran gérés par le navigateur), habillée comme un champ. */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select className={cn(inputClass, 'appearance-none pr-10', className)} {...props} />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3.5 size-[18px] -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
