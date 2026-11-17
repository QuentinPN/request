import { roleLabels } from '@shared/roles.ts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Bookmark, ChartColumn, LogOut, Settings } from 'lucide-react';
import { NotificationSettings } from '@/components/account/notification-settings';
import { Notice } from '@/components/notice';
import { Page } from '@/components/page';
import { Avatar } from '@/components/shell/avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import { useViewer } from '@/hooks/use-viewer';
import { apiSend } from '@/lib/http';
import { releaseDevicePush } from '@/lib/push';
import { forgetSession } from '@/lib/session';

export function ComptePage() {
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
          {/* Hors de la barre d'onglets du mobile, déjà pleine : on y accède d'ici. */}
          <Link to="/ma-liste" className={buttonVariants({ variant: 'secondary' })}>
            <Bookmark data-icon="inline-start" />
            Ma liste
          </Link>
          {viewer.capabilities.canViewStats && (
            <Link to="/statistiques" className={buttonVariants({ variant: 'secondary' })}>
              <ChartColumn data-icon="inline-start" />
              Statistiques
            </Link>
          )}
          {viewer.capabilities.isOwner && (
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
