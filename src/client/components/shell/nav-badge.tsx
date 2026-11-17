import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { useViewer } from '@/hooks/use-viewer';
import { requestCountsQuery } from '@/lib/requests';
import type { NavItem } from './nav-items';

/**
 * Compteur d'une entrée de navigation (maquettes : `.count`) : demandes en attente d'approbation. Rien tant que le
 * chiffre manque, qu'il est nul ou que le serveur ne répond pas ; ne bloque jamais la navigation. Le chiffre est
 * décoratif, le texte caché le dit aux lecteurs d'écran.
 */
export function NavBadge({ item, className }: { item: NavItem; className?: string }) {
  const canManage = useViewer()?.capabilities.canManageRequests === true;
  const { data } = useQuery({ ...requestCountsQuery(), enabled: item.count === 'pendingApprovals' && canManage });
  // Le cache est partagé : sans ce test, chaque entrée de la navigation afficherait le chiffre.
  const count = item.count === 'pendingApprovals' ? data?.pendingApprovals : null;
  if (!count) return null;
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-(--text-inverse)',
          className,
        )}
      >
        {count}
      </span>
      <span className="sr-only">, {count} en attente</span>
    </>
  );
}
