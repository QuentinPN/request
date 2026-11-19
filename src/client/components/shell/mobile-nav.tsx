import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { type LucideIcon, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { MenuBadge, NavBadge } from './nav-badge';
import { activeOptions, focusRing, useMenuActive, useNavItems, useSettingsActive } from './nav-items';
import { searchShortcut, useOpenSearch } from './search';

// Cinq onglets au plus (gestionnaire) dans 390 px.
const tab = cn(
  'relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1 text-[10px] font-semibold text-muted-foreground aria-[current=page]:text-foreground',
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

// Barre d'onglets flottante du mobile (< 1024 px), comme dans la maquette R-Mobile. Le reste (Ma liste, Signalements,
// Statistiques) s'ouvre depuis Compte ; les notifications, depuis la cloche de l'en-tête.
export function MobileNav() {
  const [home, ...rest] = useNavItems('tabs');
  const openSearch = useOpenSearch();
  const menuActive = useMenuActive();
  const settingsActive = useSettingsActive();
  const accountSection = menuActive || settingsActive;
  const link = (item: NonNullable<typeof home>) => (
    <Link
      key={item.to}
      to={item.to}
      activeOptions={activeOptions(item.to)}
      aria-current={accountSection && item.in.includes('account') ? 'page' : undefined}
      className={tab}
    >
      <TabContent icon={item.icon}>{item.mobileLabel ?? item.label}</TabContent>
      <NavBadge item={item} className={tabBadge} />
      {item.in.includes('account') && <MenuBadge className={tabBadge} />}
    </Link>
  );
  return (
    <nav
      aria-label="Navigation"
      className="glass fixed inset-x-4 bottom-[calc(20px+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md h-16 items-center justify-around rounded-[32px] px-1 lg:hidden"
    >
      {home && link(home)}
      <button type="button" onClick={openSearch} aria-keyshortcuts={searchShortcut.aria} className={tab}>
        <TabContent icon={Search}>Rechercher</TabContent>
      </button>
      {rest.map(link)}
    </nav>
  );
}
