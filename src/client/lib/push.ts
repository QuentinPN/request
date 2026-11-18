import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  NOTIFICATION_PREFERENCES_PATH,
  type NotificationPreferences,
  type NotificationPreferencesView,
  PUSH_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_CHECK_PATH,
  PUSH_SUBSCRIPTION_PATH,
  PUSH_TEST_PATH,
  type PushPublicKey,
  type PushSubscriptionCheck,
  SERVICE_WORKER_PATH,
} from '../../shared/notifications.ts';
import { apiGet, apiSend } from './http.ts';

// Préférences de notification du membre (Compte) et push web de cet appareil (service worker `public/sw.js`).

/** Service worker de l'appli installable : en production seulement (en développement, Vite sert tout en direct). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SERVICE_WORKER_PATH).catch(() => undefined);
  });
}

export const notificationPreferencesQuery = queryOptions({
  queryKey: ['account', 'notifications'],
  queryFn: ({ signal }) => apiGet<NotificationPreferencesView>(NOTIFICATION_PREFERENCES_PATH, undefined, signal),
});

export function useSaveNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (preferences: NotificationPreferences) =>
      apiSend<NotificationPreferencesView>('PUT', NOTIFICATION_PREFERENCES_PATH, preferences),
    onSuccess: (saved) => queryClient.setQueryData(notificationPreferencesQuery.queryKey, saved),
  });
}

/**
 * Push sur cet appareil : `unsupported` (navigateur sans push, page hors HTTPS, ou appli en développement),
 * `denied` (permission refusée dans le navigateur), `off` (pas abonné pour ce membre), `on` (abonné pour ce membre).
 */
export type DevicePushState = 'unsupported' | 'denied' | 'off' | 'on';

const pushSupported = () =>
  import.meta.env.PROD &&
  window.isSecureContext &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

const currentSubscription = async () =>
  (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null;

export async function devicePushState(): Promise<DevicePushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  // Appareil partagé : l'abonnement du navigateur peut appartenir à un autre membre ; le serveur tranche.
  const { subscribed } = await apiSend<PushSubscriptionCheck>('POST', PUSH_SUBSCRIPTION_CHECK_PATH, {
    endpoint: subscription.endpoint,
  });
  return subscribed ? 'on' : 'off';
}

export const devicePushQuery = queryOptions({ queryKey: ['account', 'push-device'], queryFn: devicePushState });

/** Clé publique VAPID (base64url) en octets, comme l'attend `pushManager.subscribe`. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Permission du navigateur, abonnement de l'appareil, puis enregistrement côté serveur. */
async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error('Notifications refusées : autorisez-les pour ce site dans les réglages du navigateur.');
  const { publicKey } = await apiGet<PushPublicKey>(PUSH_PUBLIC_KEY_PATH);
  await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await apiSend('PUT', PUSH_SUBSCRIPTION_PATH, subscription.toJSON());
}

/** Désabonne cet appareil (serveur d'abord : il ne doit plus rien y envoyer). */
async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await apiSend('DELETE', PUSH_SUBSCRIPTION_PATH, { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/**
 * Déconnexion : cet appareil cesse de recevoir les notifications du membre (serveur, puis navigateur). Un appareil
 * abonné pour un autre membre est laissé tel quel ; un échec n'empêche jamais la déconnexion.
 */
export async function releaseDevicePush(): Promise<void> {
  try {
    if ((await devicePushState()) === 'on') await disablePush();
  } catch {
    // La session se ferme quand même ; un appareil oublié côté serveur est purgé à son premier refus (404, 410).
  }
}

/** Active ou coupe le push sur cet appareil, puis relit son état et le nombre d'appareils abonnés. */
export function useDevicePush() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => (on ? enablePush() : disablePush()),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: devicePushQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: notificationPreferencesQuery.queryKey });
    },
  });
}

/** Notification d'essai vers les appareils abonnés du membre. */
export const usePushTest = () =>
  useMutation({ mutationFn: () => apiSend<{ reached: number }>('POST', PUSH_TEST_PATH) });
