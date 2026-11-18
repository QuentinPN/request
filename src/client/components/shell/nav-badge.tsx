import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { useViewer } from '@/hooks/use-viewer';
import { issueCountsQuery } from '@/lib/issues';
import { requestCountsQuery } from '@/lib/requests';
import { type NavItem, useNavItems } from './nav-items';

/**
 * Pastille chiffrée (maquettes : `.count`). Le chiffre est décoratif, `label` le dit aux lecteurs d'écran, à la suite
 * du libellé du lien ou du bouton.
 */
export function CountBadge({ count, label, className }: { count: number; label: string; className?: string }) {
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
      <span className="sr-only">, {label}</span>
    </>
  );
}

/**
 * Compteur d'une entrée de navigation, pour qui la gère : demandes en attente d'approbation, signalements ouverts.
 * Rien tant que le chiffre manque, qu'il est nul ou que le serveur ne répond pas ; ne bloque jamais la navigation.
 */
export function NavBadge({ item, className }: { item: NavItem; className?: string }) {
  const capabilities = useViewer()?.capabilities;
  const approvals = useQuery({
    ...requestCountsQuery(),
    enabled: item.count === 'pendingApprovals' && capabilities?.canManageRequests === true,
  });
  const issues = useQuery({
    ...issueCountsQuery(),
    enabled: item.count === 'openIssues' && capabilities?.canManageIssues === true,
  });
  // Le cache est partagé : sans ce test, chaque entrée de la navigation afficherait le chiffre.
  const count = item.count === 'pendingApprovals' ? approvals.data?.pendingApprovals : issues.data?.open;
  if (!item.count || !count) return null;
  const label =
    item.count === 'openIssues'
      ? `${count} signalement${count > 1 ? 's' : ''} ouvert${count > 1 ? 's' : ''}`
      : `${count} en attente`;
  return <CountBadge count={count} label={label} className={className} />;
}

/** Compteurs des entrées du menu « Plus », reportés sur ce qui y mène (bouton « Plus », onglet Compte). */
export function MenuBadge({ className }: { className?: string }) {
  const items = useNavItems('menu');
  return (
    <>
      {items.map((item) => (
        <NavBadge key={item.to} item={item} className={className} />
      ))}
    </>
  );
}
