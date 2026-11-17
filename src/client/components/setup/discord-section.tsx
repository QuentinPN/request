import { DISCORD_SETTINGS_PATH, DISCORD_TEST_PATH } from '@shared/discord.ts';
import { type RequestNotificationKind, requestNotificationKinds } from '@shared/notifications.ts';
import { type MaskedSetting, type SettingInput, settingSchemas } from '@shared/settings.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { apiSend } from '@/lib/http';
import { discordEventLabels } from './config';
import { discordQuery } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

const webhookUrlSchema = settingSchemas.discord.shape.webhookUrl;
const URL_ERROR = 'Adresse attendue : https://discord.com/api/webhooks/…';

const checkboxClass = 'size-4 accent-(--accent-play)';

function DiscordForm({ stored, ...frame }: SectionFrameProps & { stored: MaskedSetting<'discord'> }) {
  const id = useId();
  const queryClient = useQueryClient();
  // Vide : garder l'adresse enregistrée (elle ne revient jamais du serveur).
  const [url, setUrl] = useState('');
  const [enabled, setEnabled] = useState(stored.enabled);
  const [events, setEvents] = useState<RequestNotificationKind[]>(stored.events);

  const save = useMutation({
    mutationFn: (value: SettingInput<'discord'>) =>
      apiSend<MaskedSetting<'discord'>>('PUT', DISCORD_SETTINGS_PATH, value),
    onSuccess: (saved) => {
      queryClient.setQueryData(discordQuery.queryKey, saved);
      setUrl('');
    },
  });
  const test = useMutation({
    mutationFn: (webhookUrl: string | undefined) =>
      apiSend<{ ok: true }>('POST', DISCORD_TEST_PATH, webhookUrl ? { webhookUrl } : {}),
  });

  const typed = url.trim();
  const urlError = typed !== '' && !webhookUrlSchema.safeParse(typed).success ? URL_ERROR : null;
  const hasUrl = typed !== '' || stored.webhookUrl.set;
  const missingUrl = enabled && !hasUrl;
  const canTest = hasUrl && !urlError && !test.isPending;
  const canSave = !urlError && !missingUrl && !save.isPending;

  const edit = (change: () => void) => {
    change();
    save.reset();
    test.reset();
  };
  const toggleEvent = (kind: RequestNotificationKind, on: boolean) =>
    edit(() => setEvents((current) => requestNotificationKinds.filter((k) => (k === kind ? on : current.includes(k)))));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) save.mutate({ ...(typed && { webhookUrl: typed }), enabled, events });
  };

  const status = sectionStatus({
    saved: stored.enabled && stored.webhookUrl.set,
    // Facultative : ouverte ou non, elle reste « Désactivée » tant qu’elle n’est pas active.
    open: false,
    failed: save.isError || test.isError,
    testing: save.isPending || test.isPending,
  });
  const fieldError = urlError ?? (missingUrl ? 'Collez l’adresse du webhook pour activer les notifications.' : null);

  return (
    <SectionFrame {...frame} status={status} doneLabel="Actif" todoLabel="Désactivé">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Dans Discord : Paramètres du salon › Intégrations › Webhooks › Nouveau webhook, puis « Copier l’URL du webhook
          ». Rien n’est envoyé tant que cette option est désactivée.
        </p>
        <label className="flex min-h-11 items-center gap-3 rounded-[12px] bg-muted px-3 py-2.5 text-sm font-semibold">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={enabled}
            onChange={(e) => edit(() => setEnabled(e.target.checked))}
          />
          Envoyer les notifications sur Discord
        </label>
        <div>
          <Label htmlFor={`${id}-url`}>Adresse du webhook</Label>
          <Input
            id={`${id}-url`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={stored.webhookUrl.set ? 'Adresse enregistrée' : 'https://discord.com/api/webhooks/…'}
            aria-describedby={`${id}-url-hint`}
            aria-invalid={fieldError ? true : undefined}
            value={url}
            onChange={(e) => edit(() => setUrl(e.target.value))}
          />
          <FieldHint id={`${id}-url-hint`} className={fieldError ? 'text-(--text-danger)' : undefined}>
            {fieldError ??
              (stored.webhookUrl.set
                ? 'Enregistrée et chiffrée : laissez vide pour la garder, ou collez-en une nouvelle.'
                : 'Elle donne le droit d’écrire dans le salon : elle est chiffrée et ne s’affiche plus ensuite.')}
          </FieldHint>
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">Évènements envoyés</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {requestNotificationKinds.map((kind) => (
              <label
                key={kind}
                className="flex min-h-11 items-center gap-3 rounded-[12px] bg-muted px-3 py-2.5 text-sm"
              >
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={events.includes(kind)}
                  onChange={(e) => toggleEvent(kind, e.target.checked)}
                />
                {discordEventLabels[kind]}
              </label>
            ))}
          </div>
          <FieldHint>Un message par évènement, pas un par destinataire.</FieldHint>
        </fieldset>
        <div role="status" className="empty:hidden">
          {save.isError ? (
            <Notice tone="error">{save.error.message}</Notice>
          ) : test.isError ? (
            <Notice tone="error">{test.error.message}</Notice>
          ) : save.isSuccess ? (
            <Notice tone="ok">Notifications Discord enregistrées</Notice>
          ) : test.isSuccess ? (
            <Notice tone="ok">Message de test envoyé : vérifiez votre salon Discord.</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className={actionClass}
            disabled={!canTest}
            onClick={() => test.mutate(typed || undefined)}
          >
            {test.isPending ? 'Envoi…' : 'Tester'}
          </Button>
          <Button type="submit" size="lg" className={actionClass} disabled={!canSave}>
            Enregistrer
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}

/** Notifications Discord (propriétaire), facultatives et désactivées par défaut : hors de l'assistant. */
export function DiscordSection(frame: SectionFrameProps) {
  const query = useQuery(discordQuery);

  if (query.isPending)
    return (
      <SectionFrame {...frame} status="todo" todoLabel="Désactivé">
        <div role="status" className="space-y-4">
          <span className="sr-only">Chargement…</span>
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
        </div>
      </SectionFrame>
    );
  if (query.isError)
    return (
      <SectionFrame {...frame} status="error">
        <ErrorState message="Ces réglages n’ont pas pu se charger." onRetry={() => void query.refetch()} />
      </SectionFrame>
    );
  return <DiscordForm {...frame} stored={query.data} />;
}
