import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';

export function DecouvrirPage() {
  return (
    <Page title="Découvrir">
      <EmptyState
        title="Le catalogue arrive bientôt"
        description="Les tendances, les nouveautés et les titres populaires s’afficheront ici dès que le catalogue sera relié."
      />
    </Page>
  );
}
