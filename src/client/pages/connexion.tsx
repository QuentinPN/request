import type { LoginInput, Viewer } from '@shared/auth.ts';
import {
  loginMethodOf,
  PLEX_PIN_CHECK_PATH,
  PLEX_PIN_PATH,
  PLEX_PIN_POLL_MS,
  type PlexPinCreated,
  type PlexPinState,
} from '@shared/media-server.ts';
import { mediaServerKindLabels } from '@shared/settings.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { BarePage } from '@/components/bare-page';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { ApiError, apiSend } from '@/lib/http';
import { setupStateQuery, viewerQuery } from '@/lib/session';

const route = getRouteApi('/connexion');

const cardClass = 'flex flex-col gap-4 rounded-card border border-border bg-card p-6 lg:p-8';

/** Membre connecté : il devient le membre courant, puis retour à la page demandée. */
function useSignedIn() {
  const { retour } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (viewer: Viewer) => {
    queryClient.setQueryData(viewerQuery.queryKey, viewer);
    // Le premier administrateur devient propriétaire : l'état de l'installation a pu changer.
    await queryClient.invalidateQueries({ queryKey: setupStateQuery.queryKey });
    await navigate({ href: retour ?? '/' });
  };
}

/**
 * Connexion avec le compte du serveur multimédia, sans nouvel identifiant : identifiant et mot de passe pour Emby et
 * Jellyfin, bouton « Se connecter avec Plex » (code PIN validé dans une fenêtre app.plex.tv) pour Plex.
 */
export function ConnexionPage() {
  const { data: setup } = useQuery(setupStateQuery);
  const kind = setup?.mediaServerKind ?? null;
  const name = kind ? mediaServerKindLabels[kind] : 'serveur multimédia';
  const missing = setup?.hasOwner === true && !setup.services.mediaServer && (
    <Notice tone="error">{`Le serveur multimédia n’est plus configuré : contactez le propriétaire de l’application.`}</Notice>
  );

  return (
    <BarePage
      title="Connexion"
      intro={`Avec votre compte ${name}, sans nouvel identifiant.`}
      className="min-h-dvh max-w-[calc(440px+var(--space-page)*2)] justify-center"
    >
      {kind && loginMethodOf(kind) === 'plex' ? (
        <PlexLogin notice={missing} />
      ) : (
        <PasswordLogin name={name} notice={missing} />
      )}
    </BarePage>
  );
}

/** Erreur de connexion, avec le lien vers l'assistant si le serveur multimédia n'est pas configuré (409). */
function LoginError({ error }: { error: Error }) {
  return (
    <Notice tone="error" role="alert">
      {error.message}
      {error instanceof ApiError && error.status === 409 && (
        <>
          {' · '}
          <Link to="/assistant" className="font-semibold underline underline-offset-2">
            Configurer le serveur multimédia
          </Link>
        </>
      )}
    </Notice>
  );
}

function PasswordLogin({ name, notice }: { name: string; notice: ReactNode }) {
  const signedIn = useSignedIn();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);

  const login = useMutation({
    // Un 401 ici est un identifiant refusé, pas une session perdue : pas de redirection globale.
    meta: { authRedirect: false },
    mutationFn: (input: LoginInput) => apiSend<{ viewer: Viewer }>('POST', '/api/auth/login', input),
    onSuccess: ({ viewer }) => signedIn(viewer),
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

  return (
    <form onSubmit={onSubmit} aria-label={`Connexion avec votre compte ${name}`} className={cardClass}>
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
      {notice}
      {login.error && <LoginError error={login.error} />}
      <Button type="submit" size="lg" disabled={login.isPending} aria-busy={login.isPending}>
        Se connecter
      </Button>
    </form>
  );
}

/** Nom de la fenêtre app.plex.tv : un second clic la réutilise au lieu d'en ouvrir une autre. */
const PLEX_WINDOW = 'request-plex';

/**
 * Connexion Plex : le serveur crée un code PIN, la fenêtre app.plex.tv le fait valider par le membre, le navigateur
 * interroge le serveur jusqu'à la validation (qui ouvre la session) ou l'expiration.
 */
function PlexLogin({ notice }: { notice: ReactNode }) {
  const signedIn = useSignedIn();
  const popup = useRef<Window | null>(null);
  const [pin, setPin] = useState<PlexPinCreated | null>(null);

  const closePopup = () => {
    popup.current?.close();
    popup.current = null;
  };
  // Page quittée pendant l'attente : la fenêtre Plex se ferme avec elle.
  useEffect(() => () => popup.current?.close(), []);

  const create = useMutation({
    meta: { authRedirect: false },
    mutationFn: () => apiSend<PlexPinCreated>('POST', PLEX_PIN_PATH),
    onSuccess: (created) => {
      if (popup.current && !popup.current.closed) popup.current.location.href = created.authUrl;
      setPin(created);
    },
    onError: closePopup,
  });

  // Interrogé toutes les `PLEX_PIN_POLL_MS` tant que le code attend ; validé (session ouverte) ou refusé, c'est fini.
  const state = useQuery({
    queryKey: ['plex-pin', pin?.authUrl],
    queryFn: async () => {
      try {
        const result = await apiSend<PlexPinState>('POST', PLEX_PIN_CHECK_PATH);
        if (result.status === 'authorized') {
          closePopup();
          await signedIn(result.viewer);
        }
        return result;
      } catch (error) {
        closePopup();
        throw error;
      }
    },
    enabled: pin !== null,
    meta: { authRedirect: false },
    retry: false,
    gcTime: 0,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? PLEX_PIN_POLL_MS : false),
  });
  const authorized = state.data?.status === 'authorized' ? state.data.viewer : null;

  const start = () => {
    // Ouverte tout de suite, dans le geste du clic : un bloqueur de fenêtres laisse passer, l'adresse suit.
    popup.current = window.open('', PLEX_WINDOW, 'popup,width=600,height=720');
    setPin(null);
    create.mutate();
  };
  const cancel = () => {
    closePopup();
    setPin(null);
    create.reset();
  };

  const waiting = pin !== null && !state.isError && !authorized;
  const error = create.error ?? (state.isError ? state.error : null);

  return (
    <section aria-label="Connexion avec votre compte Plex" className={cardClass}>
      {waiting ? (
        <div role="status" className="flex flex-col gap-2">
          <p className="font-semibold">En attente de Plex…</p>
          <p className="text-sm text-muted-foreground">
            Validez la connexion dans la fenêtre Plex. Elle ne s’est pas ouverte ?{' '}
            <a
              href={pin.authUrl}
              target={PLEX_WINDOW}
              rel="noreferrer"
              className="font-semibold text-foreground underline underline-offset-2"
            >
              Ouvrir la fenêtre Plex
            </a>
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Une fenêtre Plex s’ouvre : connectez-vous avec le compte qui a accès au serveur, puis revenez ici.
        </p>
      )}
      {notice}
      {error && <LoginError error={error} />}
      {waiting ? (
        <Button type="button" variant="secondary" size="lg" onClick={cancel}>
          Annuler
        </Button>
      ) : (
        <Button
          type="button"
          size="lg"
          onClick={start}
          disabled={create.isPending || authorized !== null}
          aria-busy={create.isPending}
        >
          Se connecter avec Plex
        </Button>
      )}
    </section>
  );
}
