import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';

export function FilmsPage() {
  return (
    <Page title="Films">
      <EmptyState
        title="Aucun film à afficher pour l’instant"
        description="Les films du catalogue, avec leur disponibilité sur Emby, apparaîtront ici."
      />
    </Page>
  );
}
