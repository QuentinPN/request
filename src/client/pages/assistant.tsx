import { mediaServerKindLabels } from '@shared/settings.ts';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BarePage } from '@/components/bare-page';
import { Notice } from '@/components/notice';
import { actionClass } from '@/components/setup/section-frame';
import { SetupSections } from '@/components/setup/setup-sections';
import { buttonVariants } from '@/components/ui/button';
import { setupStateQuery } from '@/lib/session';

export function AssistantPage() {
  const { data: setup } = useSuspenseQuery(setupStateQuery);
  const awaitingOwner = !setup.hasOwner && setup.services.mediaServer;
  const name = setup.mediaServerKind ? mediaServerKindLabels[setup.mediaServerKind] : 'Le serveur multimédia';
  // Plex : le premier propriétaire est le propriétaire du serveur ; Emby et Jellyfin : un administrateur.
  const ownerAccount =
    setup.mediaServerKind === 'plex' ? 'le compte Plex propriétaire du serveur' : `un compte administrateur ${name}`;

  return (
    <BarePage
      title="Configuration"
      intro="Chaque section est testée en direct. Rien n’est modifié dans vos services."
      className="max-w-[calc(760px+var(--space-page)*2)]"
    >
      {awaitingOwner && (
        <Notice tone="info" role="status">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>
              {name} est relié. Connectez-vous avec {ownerAccount} pour continuer.
            </p>
            <Link
              to="/connexion"
              search={{ retour: '/assistant' }}
              className={buttonVariants({ size: 'lg', className: actionClass })}
            >
              Se connecter
            </Link>
          </div>
        </Notice>
      )}
      <SetupSections wizard />
      {setup.complete && (
        <div className="flex flex-col sm:items-end">
          <Link to="/" className={buttonVariants({ size: 'lg', className: actionClass })}>
            Terminer
          </Link>
        </div>
      )}
    </BarePage>
  );
}
