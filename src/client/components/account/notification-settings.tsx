import {
  type NotificationKind,
  type NotificationPreferencesView,
  notificationGroupLabels,
  notificationGroups,
  notificationKinds,
  notificationPreferencesSchema,
  notificationTypes,
} from '@shared/notifications.ts';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { eventLabels } from '@/components/setup/config';
import { ErrorState, Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { CheckboxField, CheckboxRow, FieldHint, Input, Label } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useMediaServerName } from '@/lib/media-server';
import {
  type DevicePushState,
  devicePushQuery,
  notificationPreferencesQuery,
  useDevicePush,
  usePushTest,
  useSaveNotificationPreferences,
} from '@/lib/push';

const emailSchema = notificationPreferencesSchema.shape.email;
const cardClass = 'flex max-w-[760px] flex-col gap-4 rounded-card bg-card p-5 ring-1 ring-border';

const devicesLabel = (n: number) =>
  n === 0 ? 'Aucun appareil abonné' : `${n} appareil${n > 1 ? 's' : ''} abonné${n > 1 ? 's' : ''}`;

/** État du push sur cet appareil, et ce que le membre peut y faire. */
const deviceText: Record<DevicePushState, string> = {
  unsupported:
    'Ce navigateur ne permet pas les notifications push ici. Il faut l’appli en HTTPS ; sur iPhone et iPad, ajoutez-la d’abord à l’écran d’accueil.',
  denied:
    'Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur, puis rechargez la page.',
  off: 'Les notifications push ne sont pas activées sur cet appareil.',
  on: 'Les notifications push sont activées sur cet appareil.',
};

function DevicePush({ devices }: { devices: number }) {
  const state = useQuery(devicePushQuery);
  const toggle = useDevicePush();
  const test = usePushTest();
  const current = state.data;

  if (state.isPending) return <Skeleton className="h-12 w-full rounded-(--r-button)" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Cet appareil</h3>
        {current === 'unsupported' || current === 'denied' ? (
          <Notice tone={current === 'denied' ? 'error' : 'info'}>{deviceText[current]}</Notice>
        ) : (
          <p className="text-sm text-muted-foreground">
            {current ? deviceText[current] : 'État inconnu.'} {devicesLabel(devices)} en tout.
          </p>
        )}
      </div>
      <div role="status" className="empty:hidden">
        {toggle.isError ? (
          <Notice tone="error">{toggle.error.message}</Notice>
        ) : test.isError ? (
          <Notice tone="error">{test.error.message}</Notice>
        ) : test.isSuccess ? (
          <Notice tone="ok">Notification d’essai envoyée.</Notice>
        ) : null}
      </div>
      {(current === 'off' || current === 'on') && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {current === 'on' ? (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={toggle.isPending}
                onClick={() => {
                  test.reset();
                  toggle.mutate(false);
                }}
              >
                Désactiver sur cet appareil
              </Button>
              <Button type="button" variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? 'Envoi…' : 'Envoyer un essai'}
              </Button>
            </>
          ) : (
            <Button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
              <BellRing data-icon="inline-start" />
              {toggle.isPending ? 'Activation…' : 'Activer sur cet appareil'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Types que le membre peut recevoir (ceux de `stored.types`), groupés : une case par type, valable pour les trois canaux. */
function NotificationTypes({
  value,
  onChange,
}: {
  value: Partial<Record<NotificationKind, boolean>>;
  onChange: (kind: NotificationKind, enabled: boolean) => void;
}) {
  const labels = eventLabels(useMediaServerName());
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">Types de notification</h3>
        <FieldHint>Un type décoché n’arrive ni dans la cloche, ni par courriel, ni en push.</FieldHint>
      </div>
      {notificationGroups.map((group) => {
        const kinds = notificationKinds.filter((kind) => kind in value && notificationTypes[kind].group === group);
        if (kinds.length === 0) return null;
        return (
          <fieldset key={group} className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-semibold text-muted-foreground">
              {notificationGroupLabels[group]}
            </legend>
            {kinds.map((kind) => (
              <CheckboxRow
                key={kind}
                checked={value[kind] === true}
                onChange={(checked) => onChange(kind, checked)}
                label={labels[kind]}
                hint={notificationTypes[kind].hint}
              />
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

function PreferencesForm({ stored }: { stored: NotificationPreferencesView }) {
  const id = useId();
  const save = useSaveNotificationPreferences();
  const [email, setEmail] = useState(stored.email ?? '');
  const [emailNotifications, setEmailNotifications] = useState(stored.emailNotifications);
  const [pushNotifications, setPushNotifications] = useState(stored.pushNotifications);
  const [types, setTypes] = useState(stored.types);

  const typed = email.trim();
  const emailError = typed !== '' && !emailSchema.safeParse(typed).success ? 'Adresse invalide' : null;
  const edit = (change: () => void) => {
    change();
    save.reset();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!emailError) save.mutate({ email: typed || null, emailNotifications, pushNotifications, types });
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor={`${id}-email`}>Adresse courriel</Label>
        <Input
          id={`${id}-email`}
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          placeholder="vous@exemple.fr"
          aria-describedby={`${id}-email-hint`}
          aria-invalid={emailError ? true : undefined}
          value={email}
          onChange={(e) => edit(() => setEmail(e.target.value))}
        />
        <FieldHint id={`${id}-email-hint`} className={emailError ? 'text-(--text-danger)' : undefined}>
          {emailError ??
            (stored.emailAvailable
              ? 'Seulement pour vos notifications ; laissez vide pour n’en recevoir aucune par courriel.'
              : 'L’envoi de courriels n’est pas encore configuré : votre adresse servira dès qu’il le sera.')}
        </FieldHint>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-semibold">Recevoir les notifications</legend>
        <CheckboxField
          checked={emailNotifications}
          onChange={(e) => edit(() => setEmailNotifications(e.target.checked))}
        >
          Par courriel
        </CheckboxField>
        <CheckboxField checked={pushNotifications} onChange={(e) => edit(() => setPushNotifications(e.target.checked))}>
          Sur mes appareils (notifications push)
        </CheckboxField>
        <FieldHint>Ces deux canaux s’ajoutent à la cloche de l’appli.</FieldHint>
      </fieldset>
      <NotificationTypes
        value={types}
        onChange={(kind, enabled) => edit(() => setTypes({ ...types, [kind]: enabled }))}
      />
      <div role="status" className="empty:hidden">
        {save.isError ? (
          <Notice tone="error">{save.error.message}</Notice>
        ) : save.isSuccess ? (
          <Notice tone="ok">Préférences enregistrées</Notice>
        ) : null}
      </div>
      <div className="flex flex-col sm:flex-row sm:justify-end">
        <Button type="submit" disabled={Boolean(emailError) || save.isPending}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

/** Compte : adresse courriel, canaux et types de notification, et push sur cet appareil. */
export function NotificationSettings() {
  const query = useQuery(notificationPreferencesQuery);
  return (
    <section aria-labelledby="compte-notifications" className={cardClass}>
      <h2 id="compte-notifications" className="text-lg font-semibold">
        Notifications
      </h2>
      {query.isPending ? (
        <Loading className="space-y-4">
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
        </Loading>
      ) : query.isError ? (
        <ErrorState message="Vos préférences n’ont pas pu se charger." onRetry={() => void query.refetch()} />
      ) : (
        <>
          <PreferencesForm stored={query.data} />
          <hr className="border-border" />
          <DevicePush devices={query.data.pushDevices} />
        </>
      )}
    </section>
  );
}
