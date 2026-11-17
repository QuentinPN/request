import type { Page } from '@playwright/test';
import { DISCORD_SETTINGS_PATH, DISCORD_TEST_PATH } from '@shared/discord.ts';
import { requestNotificationKinds } from '@shared/notifications.ts';
import type { MaskedSetting, SettingInput } from '@shared/settings.ts';

// Faux réglages Discord (`/api/settings/discord`) : écritures et messages de test gardés pour les assertions.

export const WEBHOOK = 'https://discord.com/api/webhooks/123456/jeton-secret';

/** Réglages Discord du faux serveur : les écritures du formulaire et les messages de test s'y enregistrent. */
export async function mockDiscord(page: Page, initial?: Partial<MaskedSetting<'discord'>>) {
  const state = {
    saved: { webhookUrl: { set: false }, enabled: false, events: [...requestNotificationKinds], ...initial },
    puts: [] as SettingInput<'discord'>[],
    tests: [] as unknown[],
    testReply: { status: 200, json: { ok: true } as object },
  };
  await page.route(`**${DISCORD_TEST_PATH}`, (route) => {
    state.tests.push(route.request().postDataJSON());
    return route.fulfill(state.testReply);
  });
  await page.route(`**${DISCORD_SETTINGS_PATH}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.saved });
    const body = route.request().postDataJSON() as SettingInput<'discord'>;
    state.puts.push(body);
    state.saved = {
      webhookUrl: { set: Boolean(body.webhookUrl) || state.saved.webhookUrl.set },
      enabled: body.enabled ?? false,
      events: body.events ?? [...requestNotificationKinds],
    };
    return route.fulfill({ json: state.saved });
  });
  return state;
}
