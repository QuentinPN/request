import { Outlet } from '@tanstack/react-router';
import { RequestSheetProvider } from '../requests/request-sheet';
import { AppName } from './app-name';
import { DesktopNav } from './desktop-nav';
import { MobileNav } from './mobile-nav';
import { SearchProvider } from './search';

// Mise en page racine : navigation, contenu de la route, recherche Ctrl+K, feuille de demande.
export function AppShell() {
  return (
    <SearchProvider>
      <RequestSheetProvider>
        <div className="relative min-h-dvh">
          <DesktopNav />
          {/* Posé sur le contenu comme la pilule : les visuels plein cadre remontent jusqu'en haut (utilitaire bleed). */}
          <header className="absolute inset-x-0 top-0 z-40 flex h-14 items-center px-(--space-page) lg:hidden">
            <AppName className="text-base" />
          </header>
          <main className="px-(--space-page) pt-(--main-pt) pb-[calc(120px+env(safe-area-inset-bottom))] lg:pb-16">
            <Outlet />
          </main>
          <MobileNav />
        </div>
      </RequestSheetProvider>
    </SearchProvider>
  );
}
