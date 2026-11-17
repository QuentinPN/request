import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';

export function ApprobationsPage() {
  return (
    <Page title="Approbations">
      <EmptyState
        title="Rien à approuver"
        description="Les demandes des membres en attente de votre accord s’afficheront ici."
      />
    </Page>
  );
}
