import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';

export function SeriesPage() {
  return (
    <Page title="Séries">
      <EmptyState
        title="Aucune série à afficher pour l’instant"
        description="Les séries du catalogue, saison par saison, apparaîtront ici."
      />
    </Page>
  );
}
