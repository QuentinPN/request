import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  lazyRouteComponent,
  type RouteComponent,
  useRouter,
} from '@tanstack/react-router';
import { AppShell } from '@/components/shell/app-shell';
import { ErrorState, LoadingState } from '@/components/states';
import { IntrouvablePage } from '@/pages/introuvable';

// Un chunk qui a échoué reste en cache côté navigateur : seul un rechargement complet le redemande.
const chunkLoadError =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <ErrorState
      message="Cette page n’a pas pu se charger."
      onRetry={() => {
        if (chunkLoadError.test(error instanceof Error ? error.message : String(error))) {
          window.location.reload();
          return;
        }
        reset();
        void router.invalidate();
      }}
    />
  );
}

const rootRoute = createRootRoute({ component: AppShell });

// Chaque page est chargée à la demande, dans son propre fichier.
const page = <TPath extends string, TModule extends Record<string, RouteComponent>>(
  path: TPath,
  load: () => Promise<TModule>,
  name: keyof TModule & string,
) => createRoute({ getParentRoute: () => rootRoute, path, component: lazyRouteComponent(load, name) });

const routeTree = rootRoute.addChildren([
  page('/', () => import('@/pages/decouvrir'), 'DecouvrirPage'),
  page('/films', () => import('@/pages/films'), 'FilmsPage'),
  page('/series', () => import('@/pages/series'), 'SeriesPage'),
  page('/demandes', () => import('@/pages/demandes'), 'DemandesPage'),
  page('/approbations', () => import('@/pages/approbations'), 'ApprobationsPage'),
  page('/compte', () => import('@/pages/compte'), 'ComptePage'),
  page('/composants', () => import('@/pages/composants'), 'ComposantsPage'),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: () => <LoadingState />,
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: IntrouvablePage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
