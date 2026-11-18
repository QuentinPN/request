import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ChevronDown, Search } from 'lucide-react';
import { Menu, MenuContent, MenuLinkItem, MenuTrigger } from '@/components/ui/menu';
import { useViewer } from '@/hooks/use-viewer';
import { AppName } from './app-name';
import { Avatar } from './avatar';
import { MenuBadge, NavBadge } from './nav-badge';
import { activeFill, activeOptions, focusRing, roundButton, useMenuActive, useNavItems } from './nav-items';
import { Notifications } from './notifications';
import { searchShortcut, useOpenSearch } from './search';

const pillLink = cn(
  'inline-flex h-[38px] items-center gap-2 rounded-pill px-3 text-sm xl:px-4 font-medium whitespace-nowrap text-foreground transition-colors duration-(--dur) hover:bg-(--surface-3)',
  focusRing,
);

/** Menu « Plus » : les entrées secondaires de la navigation, groupées pour que la pilule tienne dès 1024 px. */
function MoreMenu() {
  const items = useNavItems('menu');
  const active = useMenuActive();
  return (
    <Menu>
      <MenuTrigger
        aria-current={active ? 'page' : undefined}
        className={cn(pillLink, 'aria-expanded:bg-(--surface-3)', activeFill)}
      >
        Plus
        <ChevronDown aria-hidden className="-mr-1 hidden size-4 xl:block" />
        <MenuBadge />
      </MenuTrigger>
      <MenuContent align="center">
        {items.map((item) => (
          <MenuLinkItem key={item.to} closeOnClick render={<Link to={item.to} />}>
            <item.icon aria-hidden />
            {item.label}
            <NavBadge item={item} className="ml-auto" />
          </MenuLinkItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

// En-tête de l'ordinateur (≥ 1024 px), posé sur le contenu comme dans la maquette R-Decouvrir. Entre 1024 et 1280 px la
// pilule se resserre (recherche réduite à l'icône, entrées plus étroites) et prend la place laissée entre le nom et la cloche.
export function DesktopNav() {
  const pill = useNavItems('pill');
  const account = useNavItems('account');
  const openSearch = useOpenSearch();
  const viewer = useViewer();

  return (
    <header className="absolute inset-x-(--space-page) top-6 z-40 hidden grid-cols-[auto_1fr_auto] items-center gap-4 lg:grid xl:grid-cols-[1fr_auto_1fr] xl:gap-6">
      <AppName className="justify-self-start text-lg" />
      <nav
        aria-label="Navigation principale"
        className="glass flex items-center gap-0.5 justify-self-center rounded-pill p-1.5"
      >
        {pill.map((item) => (
          <Link key={item.to} to={item.to} activeOptions={activeOptions(item.to)} className={cn(pillLink, activeFill)}>
            {item.label}
            <NavBadge item={item} />
          </Link>
        ))}
        <MoreMenu />
        <button
          type="button"
          onClick={openSearch}
          aria-label="Rechercher"
          aria-keyshortcuts={searchShortcut.aria}
          className={pillLink}
        >
          <Search aria-hidden className="size-[18px]" />
          <span className="hidden text-muted-foreground xl:inline">Rechercher</span>
          <kbd className="hidden rounded-md border border-input px-1.5 font-sans text-[11px] font-semibold text-muted-foreground xl:inline">
            {searchShortcut.label}
          </kbd>
        </button>
      </nav>
      <div className="flex items-center gap-3 justify-self-end">
        <Notifications />
        {account.map((item) => (
          <Link key={item.to} to={item.to} aria-label={item.label} className={cn(roundButton, activeFill)}>
            {viewer ? <Avatar viewer={viewer} /> : <item.icon aria-hidden className="size-[18px]" />}
          </Link>
        ))}
      </div>
    </header>
  );
}
