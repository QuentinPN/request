import type { LoginInput, Viewer } from '@shared/auth.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { BarePage } from '@/components/bare-page';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { ApiError, apiSend } from '@/lib/http';
import { setupStateQuery, viewerQuery } from '@/lib/session';

const route = getRouteApi('/connexion');

export function ConnexionPage() {
  const { retour } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);

  const login = useMutation({
    // Un 401 ici est un identifiant refusé, pas une session perdue : pas de redirection globale.
    meta: { authRedirect: false },
    mutationFn: (input: LoginInput) => apiSend<{ viewer: Viewer }>('POST', '/api/auth/login', input),
    onSuccess: async ({ viewer }) => {
      queryClient.setQueryData(viewerQuery.queryKey, viewer);
      // Le premier administrateur devient propriétaire : l'état de l'installation a pu changer.
      await queryClient.invalidateQueries({ queryKey: setupStateQuery.queryKey });
      await navigate({ href: retour ?? '/' });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    login.mutate({ username: String(form.get('username') ?? ''), password: String(form.get('password') ?? '') });
  };

  const { data: setup } = useQuery(setupStateQuery);
  const error = login.error;
  const embyMissing = error instanceof ApiError && error.status === 409;

  return (
    <BarePage
      title="Connexion"
      intro="Avec votre compte Emby, sans nouvel identifiant."
      className="min-h-dvh max-w-[calc(440px+var(--space-page)*2)] justify-center"
    >
      <form
        onSubmit={onSubmit}
        aria-label="Connexion avec votre compte Emby"
        className="flex flex-col gap-4 rounded-card border border-border bg-card p-6 lg:p-8"
      >
        <div>
          <Label htmlFor="username">Identifiant</Label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="password">Mot de passe</Label>
          <div className="relative">
            <Input
              ref={passwordRef}
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              className="pr-12"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Afficher le mot de passe"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute top-1 right-1 size-10 rounded-[10px] text-muted-foreground"
            >
              {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </Button>
          </div>
        </div>
        {setup?.hasOwner && !setup.services.emby && (
          <Notice tone="error">Emby n’est plus configuré : contactez le propriétaire de l’application.</Notice>
        )}
        {error && (
          <Notice tone="error" role="alert">
            {error.message}
            {embyMissing && (
              <>
                {' · '}
                <Link to="/assistant" className="font-semibold underline underline-offset-2">
                  Configurer Emby
                </Link>
              </>
            )}
          </Notice>
        )}
        <Button type="submit" size="lg" disabled={login.isPending} aria-busy={login.isPending}>
          Se connecter
        </Button>
      </form>
    </BarePage>
  );
}
