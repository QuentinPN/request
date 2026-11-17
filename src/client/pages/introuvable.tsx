import { Link } from '@tanstack/react-router';
import { Page } from '@/components/page';
import { EmptyState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';

export function IntrouvablePage() {
  return (
    <Page title="Page introuvable">
      <EmptyState
        title="Cette adresse ne mène nulle part"
        description="Le lien est peut-être ancien, ou la page a changé de place."
        action={
          <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
            Retour à Découvrir
          </Link>
        }
      />
    </Page>
  );
}
