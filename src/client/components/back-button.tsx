import { type LinkProps, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { roundButton } from '@/components/shell/nav-items';
import { Button } from '@/components/ui/button';

/** Page vers laquelle « Retour » mène quand l'historique de l'appli est vide (arrivée par un lien, onglet neuf). */
export type BackTarget = { to: NonNullable<LinkProps['to']>; label: string };

export const homeBack: BackTarget = { to: '/', label: 'Découvrir' };

/** Pages ouvertes depuis Compte : Ma liste, Signalements, Statistiques, Réglages. */
export const accountBack: BackTarget = { to: '/compte', label: 'Compte' };

/**
 * Retour dans l'historique de l'appli (restaure la page d'où l'on vient). `useCanGoBack` lit l'index d'historique du
 * routeur : à 0, on est arrivé directement sur cette page (lien, onglet neuf), et `history.back()` quitterait l'appli ;
 * on va alors à `fallback`. Le nom dit où l'on va quand c'est sûr (« Retour à Compte »).
 */
export function BackButton({ fallback = homeBack, text = false }: { fallback?: BackTarget; text?: boolean }) {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const label = canGoBack ? 'Retour' : `Retour à ${fallback.label}`;
  const onClick = () => (canGoBack ? router.history.back() : void navigate({ to: fallback.to }));
  if (!text)
    return (
      <button type="button" aria-label={label} className={roundButton} onClick={onClick}>
        <ChevronLeft aria-hidden className="size-5" />
      </button>
    );
  return (
    <Button type="button" variant="ghost" className="-ml-3 h-11 pl-2" onClick={onClick}>
      <ChevronLeft aria-hidden />
      {label}
    </Button>
  );
}
