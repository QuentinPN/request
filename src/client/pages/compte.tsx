import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';

export function ComptePage() {
  return (
    <Page title="Compte">
      <EmptyState
        title="La connexion arrive bientôt"
        description="Vous pourrez vous connecter avec votre compte Emby et retrouver ici vos quotas et vos préférences."
      />
    </Page>
  );
}
