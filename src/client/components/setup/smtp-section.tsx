import { type NotificationKind, notificationKinds, SMTP_SETTINGS_PATH, SMTP_TEST_PATH } from '@shared/notifications.ts';
import { type MaskedSetting, type SettingInput, settingSchemas, smtpSecurities } from '@shared/settings.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { CheckboxField, FieldHint, Input, Label, NativeSelect } from '@/components/ui/field';
import { ApiError, apiSend } from '@/lib/http';
import { EventsFieldset, toggleKind } from './agent-form';
import { smtpSecurityOptions } from './config';
import { smtpQuery } from './queries';
import {
  actionClass,
  LoadedSection,
  SectionActions,
  SectionFrame,
  type SectionFrameProps,
  sectionStatus,
} from './section-frame';

type Smtp = MaskedSetting<'smtp'>;
type Security = (typeof smtpSecurities)[number];

function SmtpForm({ stored, ...frame }: SectionFrameProps & { stored: Smtp | null }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(stored?.enabled ?? true);
  const [host, setHost] = useState(stored?.host ?? '');
  const [security, setSecurity] = useState<Security>(stored?.security ?? 'starttls');
  const [port, setPort] = useState(String(stored?.port ?? smtpSecurityOptions.starttls.port));
  const [username, setUsername] = useState(stored?.username ?? '');
  // Vide : garder le mot de passe enregistré (il ne revient jamais du serveur), même serveur et même compte seulement.
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(stored?.from ?? '');
  const [events, setEvents] = useState<NotificationKind[]>(stored?.events ?? [...notificationKinds]);

  const value: SettingInput<'smtp'> = {
    enabled,
    host: host.trim(),
    port: Number(port),
    security,
    username: username.trim() || null,
    ...(password && { password }),
    from: from.trim(),
    events,
  };
  const valid = settingSchemas.smtp.safeParse(value).success;

  const save = useMutation({
    mutationFn: (input: SettingInput<'smtp'>) => apiSend<Smtp>('PUT', SMTP_SETTINGS_PATH, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(smtpQuery.queryKey, saved);
      setPassword('');
    },
  });
  const test = useMutation({
    mutationFn: (input: SettingInput<'smtp'>) => apiSend<{ ok: true }>('POST', SMTP_TEST_PATH, input),
  });

  const edit = (change: () => void) => {
    change();
    save.reset();
    test.reset();
  };
  /** Nouvelle sécurité : son port habituel, si le port était celui de l'ancienne. */
  const changeSecurity = (next: Security) =>
    edit(() => {
      if (Number(port) === smtpSecurityOptions[security].port) setPort(String(smtpSecurityOptions[next].port));
      setSecurity(next);
    });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !save.isPending) save.mutate(value);
  };

  const status = sectionStatus({
    saved: stored?.enabled === true,
    open: false,
    failed: save.isError || test.isError,
    testing: save.isPending || test.isPending,
  });
  const field = (name: string) => `${id}-${name}`;

  return (
    <SectionFrame {...frame} status={status} doneLabel="Actif" todoLabel="Désactivé">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Le serveur d’envoi de votre messagerie ou d’un service d’envoi (SMTP). Chaque membre choisit dans son Compte
          son adresse et s’il veut recevoir ses notifications par courriel.
        </p>
        <CheckboxField
          className="font-semibold"
          checked={enabled}
          onChange={(e) => edit(() => setEnabled(e.target.checked))}
        >
          Envoyer les notifications par courriel
        </CheckboxField>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <div>
            <Label htmlFor={field('host')}>Serveur SMTP</Label>
            <Input
              id={field('host')}
              autoComplete="off"
              spellCheck={false}
              placeholder="smtp.exemple.fr"
              value={host}
              onChange={(e) => edit(() => setHost(e.target.value))}
            />
          </div>
          <div>
            <Label htmlFor={field('port')}>Port</Label>
            <Input
              id={field('port')}
              inputMode="numeric"
              autoComplete="off"
              value={port}
              onChange={(e) => edit(() => setPort(e.target.value.replace(/\D/g, '')))}
            />
          </div>
        </div>
        <div>
          <Label htmlFor={field('security')}>Sécurité</Label>
          <NativeSelect
            id={field('security')}
            value={security}
            onChange={(e) => changeSecurity(e.target.value as Security)}
          >
            {smtpSecurities.map((s) => (
              <option key={s} value={s}>
                {smtpSecurityOptions[s].label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={field('username')}>Identifiant</Label>
            <Input
              id={field('username')}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={field('username-hint')}
              value={username}
              onChange={(e) => edit(() => setUsername(e.target.value))}
            />
            <FieldHint id={field('username-hint')}>Vide si le serveur n’en demande pas.</FieldHint>
          </div>
          <div>
            <Label htmlFor={field('password')}>Mot de passe</Label>
            <Input
              id={field('password')}
              type="password"
              autoComplete="new-password"
              placeholder={stored?.password.set ? 'Mot de passe enregistré' : undefined}
              aria-describedby={field('password-hint')}
              value={password}
              onChange={(e) => edit(() => setPassword(e.target.value))}
            />
            <FieldHint id={field('password-hint')}>
              {stored?.password.set
                ? 'Chiffré : laissez vide pour le garder (même serveur et même identifiant).'
                : 'Chiffré, il ne s’affiche plus ensuite.'}
            </FieldHint>
          </div>
        </div>
        <div>
          <Label htmlFor={field('from')}>Expéditeur</Label>
          <Input
            id={field('from')}
            autoComplete="off"
            spellCheck={false}
            placeholder="Request <demandes@exemple.fr>"
            aria-describedby={field('from-hint')}
            value={from}
            onChange={(e) => edit(() => setFrom(e.target.value))}
          />
          <FieldHint id={field('from-hint')}>Adresse seule, ou « Nom &lt;adresse&gt; ».</FieldHint>
        </div>
        <EventsFieldset
          legend="Notifications envoyées par courriel"
          kinds={notificationKinds}
          selected={events}
          onToggle={(kind, on) => edit(() => setEvents((current) => toggleKind(notificationKinds, current, kind, on)))}
          hint="Décochez un type pour qu’il ne parte jamais par courriel, quel que soit le choix des membres."
        />
        <div role="status" className="empty:hidden">
          {save.isError ? (
            <Notice tone="error">{save.error.message}</Notice>
          ) : test.isError ? (
            <Notice tone="error">
              {test.error.message}
              {/* 409 : le propriétaire n'a pas encore d'adresse où recevoir l'essai. */}
              {test.error instanceof ApiError && test.error.status === 409 && (
                <>
                  {' '}
                  <Link to="/compte" className="font-semibold underline">
                    Ouvrir Compte
                  </Link>
                </>
              )}
            </Notice>
          ) : save.isSuccess ? (
            <Notice tone="ok">Courriel enregistré</Notice>
          ) : test.isSuccess ? (
            <Notice tone="ok">Courriel d’essai envoyé : vérifiez votre boîte de réception.</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className={actionClass}
            disabled={!valid || test.isPending}
            onClick={() => test.mutate(value)}
          >
            {test.isPending ? 'Envoi…' : 'Envoyer un essai'}
          </Button>
          <Button type="submit" size="lg" className={actionClass} disabled={!valid || save.isPending}>
            Enregistrer
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}

/** Courriel (propriétaire), facultatif : le serveur SMTP qui écrit aux membres. Hors de l'assistant. */
export function SmtpSection(frame: SectionFrameProps) {
  const query = useQuery(smtpQuery);
  return (
    <LoadedSection {...frame} todoLabel="Désactivé" query={query}>
      {(stored) => <SmtpForm {...frame} stored={stored} />}
    </LoadedSection>
  );
}
