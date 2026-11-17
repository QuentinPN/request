import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { ApiError, AuthRequiredError } from './lib/http.ts';
import { forgetSession } from './lib/session.ts';
import { router } from './router.tsx';

/** Session perdue en cours de route (401) : retour à la connexion, puis à la page quittée. */
function onAuthLost(error: Error, meta: Record<string, unknown> | undefined) {
  if (!(error instanceof AuthRequiredError) || meta?.authRedirect === false) return;
  forgetSession(queryClient);
  const { pathname, href } = router.state.location;
  if (pathname !== '/connexion') void router.navigate({ to: '/connexion', search: { retour: href } });
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => onAuthLost(error, query.meta) }),
  mutationCache: new MutationCache({ onError: (error, _v, _c, mutation) => onAuthLost(error, mutation.meta) }),
  defaultOptions: {
    queries: {
      // Une réponse 4xx ne changera pas en réessayant.
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root introuvable');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
