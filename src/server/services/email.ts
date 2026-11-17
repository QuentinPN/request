import { createTransport } from 'nodemailer';
import type { Setting } from '../../shared/settings.ts';
import type { Data } from '../db/index.ts';
import { HttpError } from '../lib/api-errors.ts';
import { type OutgoingMessage, testMessage } from './delivery.ts';
import { getSetting } from './settings.ts';

type SmtpSetting = Setting<'smtp'>;

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Transport d'envoi d'un réglage SMTP ; remplacé dans les tests par un faux qui garde les messages. */
export type MailTransport = (config: SmtpSetting) => { sendMail: (message: MailMessage) => Promise<unknown> };

/** Connexion, accueil du serveur et inactivité : un serveur muet ne retient ni un envoi ni la fermeture de l'appli. */
const SMTP_TIMEOUT_MS = 15_000;
/** Délai total d'un courriel d'essai, toutes étapes comprises. */
export const SMTP_TEST_DEADLINE_MS = 30_000;

/**
 * Transport nodemailer. `starttls` exige le chiffrement (`requireTLS`) : un serveur qui ne le propose pas est refusé
 * plutôt que de recevoir le mot de passe en clair ; `tls` chiffre dès la connexion (port 465).
 */
export const smtpTransport: MailTransport = (config) =>
  createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ...(config.username && { auth: { user: config.username, pass: config.password ?? '' } }),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const FOOTER =
  'Vous recevez ce courriel car les notifications par courriel sont activées dans votre Compte Request.';

/** Courriel sobre : texte brut et HTML simple (styles en ligne), lien vers l'appli si son adresse publique est connue. */
export function mailContent({ title, body, path }: OutgoingMessage, publicUrl: string | null) {
  const link = publicUrl ? `${publicUrl}${path}` : null;
  const text = [body, ...(link ? [`Ouvrir Request : ${link}`] : []), `-- \n${FOOTER}`].join('\n\n');
  const button = link
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#e8c9a6;color:#0a0a0c;font-weight:600;text-decoration:none">Ouvrir Request</a></p>`
    : '';
  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#f2f2f5;color:#1d1d1f;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px;border-radius:16px;background:#ffffff">
<p style="margin:0 0 8px;font-size:13px;color:#6e6e73">Request</p>
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.5">${escapeHtml(body)}</p>${button}
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#6e6e73">${escapeHtml(FOOTER)}</p>
</body></html>`;
  return { subject: title, text, html };
}

/** Cause lisible d'un échec SMTP (code de nodemailer), affichée au propriétaire après un essai. */
const SMTP_ERRORS: Record<string, string> = {
  EAUTH: 'Identifiant ou mot de passe refusé par le serveur SMTP',
  ECONNECTION: 'Serveur SMTP injoignable à cette adresse',
  EDNS: 'Serveur SMTP introuvable : vérifiez l’hôte',
  ETIMEDOUT: 'Le serveur SMTP n’a pas répondu à temps',
  ESOCKET: 'Connexion au serveur SMTP interrompue (sécurité ou port incorrects ?)',
  ETLS: 'Le chiffrement avec le serveur SMTP a échoué (sécurité ou port incorrects ?)',
  EENVELOPE: 'Le serveur SMTP a refusé l’expéditeur ou le destinataire',
  EMESSAGE: 'Le serveur SMTP a refusé le message',
};
const smtpErrorMessage = (error: unknown) => {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return (typeof code === 'string' && SMTP_ERRORS[code]) || 'Le serveur SMTP a refusé l’envoi';
};

/**
 * Notifications par courriel, via le réglage SMTP du propriétaire. `publicUrl` : adresse publique de l'appli (lien
 * des courriels), `null` si inconnue.
 */
export function createEmail(data: Data, deps: { transport: MailTransport; publicUrl: string | null }) {
  const { db, cryptoKey } = data;
  const send = (config: SmtpSetting, to: string, message: OutgoingMessage) =>
    deps.transport(config).sendMail({ from: config.from, to, ...mailContent(message, deps.publicUrl) });

  return {
    /** Réglage SMTP actif, ou `null` (jamais réglé, ou désactivé) : rien ne part alors par courriel. */
    active(): SmtpSetting | null {
      const config = getSetting(db, cryptoKey, 'smtp');
      return config?.enabled ? config : null;
    },
    send,
    /**
     * Courriel d'essai (réglage enregistré ou saisi) ; un refus devient une 422 au message lisible. Le propriétaire
     * attend la réponse : au-delà de `SMTP_TEST_DEADLINE_MS` en tout (un serveur qui répond au compte-gouttes passe
     * sous les délais par étape), l'essai échoue.
     */
    async test(config: SmtpSetting, to: string) {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('Délai de l’essai SMTP dépassé'), { code: 'ETIMEDOUT' })),
          SMTP_TEST_DEADLINE_MS,
        );
      });
      try {
        await Promise.race([
          send(
            config,
            to,
            testMessage('Le serveur SMTP fonctionne : les notifications des membres partiront par courriel.'),
          ),
          deadline,
        ]);
      } catch (error) {
        throw new HttpError(422, smtpErrorMessage(error));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type EmailService = ReturnType<typeof createEmail>;
