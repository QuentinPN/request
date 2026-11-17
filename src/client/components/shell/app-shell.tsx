import { Outlet } from '@tanstack/react-router';
import { AppName } from './app-name';
import { DesktopNav } from './desktop-nav';
import { MobileNav } from './mobile-nav';
import { SearchProvider } from './search';

// Mise en page racine : navigation, contenu de la route, recherche Ctrl+K.
export function AppShell() {
  return (
    <SearchProvider>
      <div className="relative min-h-dvh">
        <DesktopNav />
        <header className="flex h-14 items-center px-(--space-page) lg:hidden">
          <AppName className="text-base" />
        </header>
        <main className="px-(--space-page) pt-4 pb-[calc(120px+env(safe-area-inset-bottom))] lg:pt-32 lg:pb-16">
          <Outlet />
        </main>
        <MobileNav />
      </div>
    </SearchProvider>
  );
}
