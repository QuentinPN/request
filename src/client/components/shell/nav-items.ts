import type { Capabilities } from '@shared/roles.ts';
import type { LinkProps } from '@tanstack/react-router';
import { Check, Clapperboard, House, List, type LucideIcon, Tv, User } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { useViewer } from '@/hooks/use-viewer';

// Emplacements : « pill » = pilule de l'ordinateur, « tabs » = barre d'onglets mobile,
// « account » = bouton rond à droite de la pilule.
type NavPlace = 'pill' | 'tabs' | 'account';

export type NavItem = {
  to: NonNullable<LinkProps['to']>;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
  in: readonly NavPlace[];
  /** Droit requis pour voir l'entrée. */
  capability?: keyof Capabilities;
  /** Compteur affiché à côté du libellé. */
  count?: 'pendingApprovals';
};

// Seule définition de la navigation, lue par la pilule et par la barre d'onglets.
export const navItems: readonly NavItem[] = [
  { to: '/', label: 'Découvrir', icon: House, in: ['pill', 'tabs'] },
  { to: '/films', label: 'Films', icon: Clapperboard, in: ['pill'] },
  { to: '/series', label: 'Séries', icon: Tv, in: ['pill'] },
  { to: '/demandes', label: 'Demandes', icon: List, in: ['pill', 'tabs'] },
  {
    to: '/approbations',
    label: 'Approbations',
    mobileLabel: 'Approuver',
    icon: Check,
    in: ['pill', 'tabs'],
    capability: 'canManageRequests',
    count: 'pendingApprovals',
  },
  { to: '/compte', label: 'Compte', icon: User, in: ['tabs', 'account'] },
];

export function useNavItems(place: NavPlace): NavItem[] {
  const viewer = useViewer();
  return navItems.filter(
    (item) => item.in.includes(place) && (!item.capability || viewer?.capabilities[item.capability] === true),
  );
}

// « / » ne doit être actif que sur l'accueil, pas sur toutes les pages.
export const activeOptions = (to: NavItem['to']) => ({ exact: to === '/' });

// Lien actif : pilule blanche pleine, déduite d'aria-current pour que l'apparence suive l'accessibilité.
export const activeFill = 'aria-[current=page]:bg-(--fill-selected) aria-[current=page]:text-(--text-inverse)';

export const focusRing = 'outline-none focus-visible:ring-3 focus-visible:ring-ring';

// Bouton rond en verre à droite de la pilule (cloche, compte).
export const roundButton = buttonVariants({ variant: 'secondary', size: 'icon', className: 'size-11' });
