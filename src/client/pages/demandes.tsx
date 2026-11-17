import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';

export function DemandesPage() {
  return (
    <Page title="Demandes">
      <EmptyState
        title="Aucune demande pour l’instant"
        description="Vos demandes de films et de séries, avec leur statut et leur progression, apparaîtront ici."
      />
    </Page>
  );
}
