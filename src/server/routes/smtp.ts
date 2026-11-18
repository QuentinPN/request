import type { FastifyInstance } from 'fastify';
import { SMTP_SETTINGS_PATH, SMTP_TEST_PATH } from '../../shared/notifications.ts';
import { type MaskedSetting, settingSchemas } from '../../shared/settings.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { ownerOnly, viewerOf } from '../plugins/auth.ts';
import type { EmailService } from '../services/email.ts';
import { getSetting, maskSetting, setSetting, withStoredSecrets } from '../services/settings.ts';

/**
 * Envoi des courriels (propriétaire seulement) : le mot de passe SMTP, un secret, ne sort jamais du serveur ; il n'est
 * réutilisé que vers le même serveur et le même compte (`withStoredSecrets`).
 */
export function smtpRoutes(app: FastifyInstance, email: EmailService) {
  const { db, cryptoKey } = app.data;
  const stored = () => getSetting(db, cryptoKey, 'smtp');
  /** Réglage du formulaire, secret vide = l'enregistré. */
  const fromForm = (body: unknown) => parseRequest(settingSchemas.smtp, withStoredSecrets('smtp', body, stored()));

  app.get(SMTP_SETTINGS_PATH, ownerOnly, async (): Promise<MaskedSetting<'smtp'>> => {
    const value = stored();
    if (!value) throw new HttpError(404, 'Pas encore configuré');
    return maskSetting('smtp', value);
  });

  app.put(
    SMTP_SETTINGS_PATH,
    ownerOnly,
    async (req): Promise<MaskedSetting<'smtp'>> =>
      maskSetting('smtp', setSetting(db, cryptoKey, 'smtp', fromForm(req.body))),
  );

  /** Essai vers l'adresse du propriétaire, avec le réglage saisi (sans l'enregistrer), sinon l'enregistré. */
  app.post(SMTP_TEST_PATH, ownerOnly, async (req) => {
    const to = viewerOf(req).user.email;
    if (!to) throw new HttpError(409, 'Renseignez d’abord votre adresse courriel dans Compte');
    const hasForm = typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length > 0;
    const config = hasForm ? fromForm(req.body) : stored();
    if (!config) throw new HttpError(409, 'Aucun serveur SMTP enregistré');
    await email.test(config, to);
    return { ok: true };
  });
}
