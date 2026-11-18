import type { NotificationPage, NotificationView } from '@shared/notifications.ts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Bell, CheckCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { useViewer } from '@/hooks/use-viewer';
import { bellLabel, notificationLink, notificationsQuery, useMarkNotificationsRead } from '@/lib/notifications';
import { formatWhen } from '@/lib/requests';
import { QueryState } from '../query-state';
import { bottomSheet } from '../requests/request-sheet';
import { EmptyState, Loading } from '../states';
import { Skeleton } from '../ui/skeleton';
import { roundButton } from './nav-items';

/** Notifications du membre (cache partagé par la cloche, l'onglet mobile et le panneau). */
export function useNotifications() {
  return useQuery({ ...notificationsQuery(), enabled: useViewer() !== null });
}

/** Non lues ; 0 tant que le chiffre manque ou que le serveur ne répond pas (la cloche reste utilisable). */
export const useUnreadCount = () => useNotifications().data?.unread ?? 0;

// --- Ordinateur : cloche ronde à droite de la pilule, panneau en popover (maquette R-Decouvrir : point d'accent) ---

/** Cloche et point d'accent des non lues, communs au popover de l'ordinateur et au bouton du mobile. */
function BellIcon({ unread }: { unread: number }) {
  return (
    <>
      <Bell aria-hidden className="size-[18px]" />
      {unread > 0 && <span aria-hidden className="absolute top-2.5 right-[11px] size-2 rounded-full bg-brand" />}
    </>
  );
}

export function Notifications() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label={bellLabel('Notifications', unread)} className={cn(roundButton, 'relative')}>
        <BellIcon unread={unread} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[380px] gap-0 p-0">
        <NotificationsPanel
          title={<PopoverTitle className={panelTitle}>Notifications</PopoverTitle>}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

// --- Mobile : feuille posée en bas de l'écran, ouverte par la cloche de l'en-tête (la barre d'onglets est réservée aux pages) ---

export function NotificationsButton() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={bellLabel('Notifications', unread)}
        className={cn(roundButton, 'relative')}
      >
        <BellIcon unread={unread} />
      </button>
      <NotificationsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

export function NotificationsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(bottomSheet, 'gap-3 max-lg:px-0 max-lg:pb-[calc(1rem+env(safe-area-inset-bottom))]')}
      >
        <span aria-hidden className="h-[5px] w-10 justify-self-center rounded-full bg-(--track)" />
        <NotificationsPanel
          title={<DialogTitle className={panelTitle}>Notifications</DialogTitle>}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

// --- Panneau commun ---

const panelTitle = 'text-base font-semibold';

function NotificationsPanel({ title, onClose }: { title: ReactNode; onClose: () => void }) {
  const query = useNotifications();
  const markRead = useMarkNotificationsRead();
  const unread = query.data?.unread ?? 0;
  return (
    <div className="grid">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 py-2">
        {title}
        {unread > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => markRead.mutate({ all: true })}
            disabled={markRead.isPending}
          >
            <CheckCheck data-icon="inline-start" />
            Tout marquer comme lu
          </Button>
        )}
      </div>
      <div className="max-h-[min(60dvh,480px)] overflow-y-auto">
        <QueryState
          query={query}
          skeleton={<PanelSkeleton />}
          errorMessage="Les notifications n’ont pas pu être chargées."
        >
          {(data) => (
            <NotificationList
              data={data}
              onOpen={(n) => {
                if (!n.read) markRead.mutate({ ids: [n.id] });
                onClose();
              }}
            />
          )}
        </QueryState>
      </div>
    </div>
  );
}

function NotificationList({ data, onOpen }: { data: NotificationPage; onOpen: (n: NotificationView) => void }) {
  if (data.results.length === 0)
    return (
      <EmptyState
        className="m-2 border-0 py-10"
        title="Aucune notification"
        description="Vous serez prévenu ici quand une demande est approuvée, refusée ou disponible."
      />
    );
  return (
    <ul className="divide-y divide-border">
      {data.results.map((n) => (
        <li key={n.id}>
          <NotificationItem notification={n} onOpen={() => onOpen(n)} />
        </li>
      ))}
    </ul>
  );
}

const itemClass = 'flex gap-3 px-4 py-3 text-left outline-none';

function NotificationItem({ notification: n, onOpen }: { notification: NotificationView; onOpen: () => void }) {
  const link = notificationLink(n);
  const content = (
    <>
      <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-brand')} />
      <span className="grid min-w-0 gap-0.5">
        <span className={cn('text-sm', n.read ? 'font-medium' : 'font-semibold')}>
          {!n.read && <span className="sr-only">Non lue : </span>}
          {n.title}
        </span>
        <span className="text-[13px] text-muted-foreground">{n.body}</span>
        <time dateTime={n.createdAt} className="text-xs text-muted-foreground">
          {formatWhen(n.createdAt)}
        </time>
      </span>
    </>
  );
  if (!link) return <div className={itemClass}>{content}</div>;
  return (
    <Link
      {...link}
      onClick={onOpen}
      className={cn(
        itemClass,
        'transition-colors duration-(--dur) hover:bg-accent focus-visible:bg-accent focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset',
      )}
    >
      {content}
    </Link>
  );
}

function PanelSkeleton() {
  return (
    <Loading label="Chargement des notifications…" className="space-y-1 p-2">
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="space-y-1.5 px-3 py-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </Loading>
  );
}
