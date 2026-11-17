import type { Viewer } from '@shared/auth.ts';
import { cn } from 'cn';
import { useState } from 'react';

/** Photo Emby du membre (relayée par l'appli), ou son initiale si elle manque ou ne charge pas. Décorative : le nom est dit à côté. */
export function Avatar({ viewer, className }: { viewer: Pick<Viewer, 'name' | 'avatarUrl'>; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = viewer.avatarUrl !== failed ? viewer.avatarUrl : null;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-(--surface-3) text-[13px] font-semibold text-foreground',
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} />
      ) : (
        viewer.name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}
