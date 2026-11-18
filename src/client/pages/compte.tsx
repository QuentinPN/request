import { roleLabels } from '@shared/roles.ts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut, Settings } from 'lucide-react';
import { NotificationSettings } from '@/components/account/notification-settings';
import { Notice } from '@/components/notice';
import { Page } from '@/components/page';
import { Avatar } from '@/components/shell/avatar';
import { NavBadge } from '@/components/shell/nav-badge';
import { useNavItems } from '@/components/shell/nav-items';
import { Button, buttonVariants } from '@/components/ui/button';
import { useViewer } from '@/hooks/use-viewer';
import { apiSend } from '@/lib/http';
import { releaseDevicePush } from '@/lib/push';
import { forgetSession } from '@/lib/session';

export function ComptePage() {
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const moreItems = useNavItems('menu');
  const logout = useMutation({
    mutationFn: async () => {
      await releaseDevicePush();
      await apiSend('POST', '/api/auth/logout');
    },
    onSuccess: async () => {
      forgetSession(queryClient);
      await navigate({ to: '/connexion' });
    },
  });
  if (!viewer) return null;

  return (
    <Page title="Compte">
      <section
        aria-label="Profil"
        className="flex flex-wrap items-center gap-4 rounded-card bg-card p-5 ring-1 ring-border"
      >
        <Avatar viewer={viewer} className="size-14 text-lg" />
        <div className="min-w-0 grow">
          <p className="truncate text-lg font-semibold">{viewer.name}</p>
          <p className="text-sm text-muted-foreground">{roleLabels[viewer.role]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Entrées de la navigation absentes de la barre d'onglets du mobile (menu « Plus » de l'ordinateur). */}
          {moreItems.map((item) => (
            <Link key={item.to} to={item.to} className={buttonVariants({ variant: 'secondary' })}>
              <item.icon data-icon="inline-start" />
              {item.label}
              <NavBadge item={item} />
            </Link>
          ))}
          {(viewer.capabilities.isOwner || viewer.capabilities.canManageBlocklist) && (
            <Link to="/reglages" className={buttonVariants({ variant: 'secondary' })}>
              <Settings data-icon="inline-start" />
              Réglages
            </Link>
          )}
          <Button variant="secondary" disabled={logout.isPending} onClick={() => logout.mutate()}>
            <LogOut data-icon="inline-start" />
            Se déconnecter
          </Button>
        </div>
      </section>
      {logout.isError && <Notice tone="error">{logout.error.message}</Notice>}
      <NotificationSettings />
    </Page>
  );
}
