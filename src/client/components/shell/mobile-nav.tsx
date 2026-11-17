import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Bell, type LucideIcon, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { unreadLabel } from '@/lib/notifications';
import { CountBadge, NavBadge } from './nav-badge';
import { activeOptions, focusRing, useNavItems } from './nav-items';
import { NotificationsSheet, useUnreadCount } from './notifications';
import { searchShortcut, useOpenSearch } from './search';

// Jusqu'à six onglets (gestionnaire) dans 390 px : chacun prend une part égale, 64 px au plus.
const tab = cn(
  'relative flex min-h-11 max-w-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1 text-[10px] font-semibold text-muted-foreground aria-[current=page]:text-foreground',
  focusRing,
);
const tabBadge = 'absolute -top-1.5 right-2 h-[18px] min-w-[18px] text-[10px]';

function TabContent({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <>
      <Icon aria-hidden className="size-[22px]" strokeWidth={1.8} />
      <span className="max-w-full truncate">{children}</span>
    </>
  );
}

/** Onglet « Alertes » : ouvre les notifications dans une feuille, avec le nombre de non lues. */
function NotificationsTab() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={tab}>
        <TabContent icon={Bell}>Alertes</TabContent>
        {unread > 0 && <CountBadge count={unread} label={unreadLabel(unread)} className={tabBadge} />}
      </button>
      <NotificationsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

// Barre d'onglets flottante du mobile (< 1024 px), comme dans la maquette R-Mobile, plus les notifications.
export function MobileNav() {
  const [home, ...rest] = useNavItems('tabs');
  const openSearch = useOpenSearch();
  const link = (item: NonNullable<typeof home>) => (
    <Link key={item.to} to={item.to} activeOptions={activeOptions(item.to)} className={tab}>
      <TabContent icon={item.icon}>{item.mobileLabel ?? item.label}</TabContent>
      <NavBadge item={item} className={tabBadge} />
    </Link>
  );
  // Le compte reste le dernier onglet, les notifications juste avant.
  const isAccount = (item: NonNullable<typeof home>) => item.in.includes('account');

  return (
    <nav
      aria-label="Navigation"
      className="glass fixed inset-x-4 bottom-[calc(20px+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md h-16 items-center justify-around rounded-[32px] px-1 lg:hidden"
    >
      {home && link(home)}
      <button type="button" onClick={openSearch} aria-keyshortcuts={searchShortcut.aria} className={tab}>
        <TabContent icon={Search}>Rechercher</TabContent>
      </button>
      {rest.filter((item) => !isAccount(item)).map(link)}
      <NotificationsTab />
      {rest.filter(isAccount).map(link)}
    </nav>
  );
}
