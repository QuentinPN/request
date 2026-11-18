import { Play } from 'lucide-react';
import type { MediaSummary } from '../../../shared/media.ts';
import { useMediaServerName, useWatchUrl } from '../../lib/media-server.ts';
import { canRequest } from '../../lib/status.ts';
import { buttonVariants } from '../ui/button.tsx';

/**
 * « Regarder dans … » du hero et de la fiche : lien vers l'interface web du serveur multimédia (Emby, Jellyfin, ou
 * app.plex.tv), rien si le titre n'y est pas ou si l'adresse publique n'est pas réglée. Bouton secondaire à côté de
 * « Demander », principal quand il n'est pas proposé.
 */
export function WatchLink({
  media,
  className,
}: {
  media: Pick<MediaSummary, 'embyItemId' | 'status'>;
  className?: string;
}) {
  const href = useWatchUrl(media.embyItemId);
  const serverName = useMediaServerName();
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({
        variant: canRequest(media.status) ? 'secondary' : 'default',
        size: 'lg',
        className,
      })}
    >
      <Play data-icon="inline-start" />
      Regarder dans {serverName}
    </a>
  );
}
