import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { type LucideIcon, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavBadge } from './nav-badge';
import { activeOptions, focusRing, useNavItems } from './nav-items';
import { searchShortcut, useOpenSearch } from './search';

const tab = cn(
  'relative flex min-h-11 w-16 flex-col items-center justify-center gap-1 rounded-2xl py-1 text-[10px] font-semibold text-muted-foreground aria-[current=page]:text-foreground',
  focusRing,
);

function TabContent({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <>
      <Icon aria-hidden className="size-[22px]" strokeWidth={1.8} />
      {children}
    </>
  );
}

// Barre d'onglets flottante du mobile (< 1024 px), comme dans la maquette R-Mobile.
export function MobileNav() {
  const [home, ...rest] = useNavItems('tabs');
  const openSearch = useOpenSearch();
  const link = (item: NonNullable<typeof home>) => (
    <Link key={item.to} to={item.to} activeOptions={activeOptions(item.to)} className={tab}>
      <TabContent icon={item.icon}>{item.mobileLabel ?? item.label}</TabContent>
      <NavBadge item={item} className="absolute -top-1.5 right-2 h-[18px] min-w-[18px] text-[10px]" />
    </Link>
  );

  return (
    <nav
      aria-label="Navigation"
      className="glass fixed inset-x-4 bottom-[calc(20px+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md h-16 items-center justify-around rounded-[32px] px-2 lg:hidden"
    >
      {home && link(home)}
      <button type="button" onClick={openSearch} aria-keyshortcuts={searchShortcut.aria} className={tab}>
        <TabContent icon={Search}>Rechercher</TabContent>
      </button>
      {rest.map(link)}
    </nav>
  );
}
