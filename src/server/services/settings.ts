import { eq } from 'drizzle-orm';
import {
  type MaskedSetting,
  normalizeUrl,
  type Setting,
  type SettingInput,
  type SettingKey,
  secretFields,
  settingSchemas,
} from '../../shared/settings.ts';
import { decrypt, encrypt } from '../crypto.ts';
import type { Data, Db } from '../db/index.ts';
import { settings } from '../db/schema.ts';
import { HttpError } from '../lib/api-errors.ts';

type Fields = Record<string, unknown>;

/** Copie de `value` où chaque champ secret de `key` passe par `fn`. */
function mapFields(key: SettingKey, value: Fields, fn: (v: unknown, field: string) => unknown): Fields {
  const out = { ...value };
  for (const field of secretFields[key] as readonly string[]) out[field] = fn(out[field], field);
  return out;
}

/** Chiffre ou déchiffre les secrets renseignés (un secret `null` reste `null`). */
const mapSecrets = (key: SettingKey, value: Fields, fn: (s: string) => string) =>
  mapFields(key, value, (v) => (typeof v === 'string' ? fn(v) : v));

/** Valide puis enregistre un réglage, secrets chiffrés. Renvoie la valeur normalisée. */
export function setSetting<K extends SettingKey>(
  db: Db,
  cryptoKey: Buffer,
  key: K,
  input: SettingInput<K>,
): Setting<K> {
  const value = settingSchemas[key].parse(input) as Setting<K>;
  const stored = JSON.stringify(mapSecrets(key, value, (s) => encrypt(cryptoKey, s)));
  db.insert(settings)
    .values({ key, value: stored })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: new Date() } })
    .run();
  return value;
}

/** Lit un réglage déchiffré, ou `null` s'il n'a jamais été enregistré. */
export function getSetting<K extends SettingKey>(db: Db, cryptoKey: Buffer, key: K): Setting<K> | null {
  const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  return settingSchemas[key].parse(mapSecrets(key, JSON.parse(row.value), (s) => decrypt(cryptoKey, s))) as Setting<K>;
}

/** Clés des réglages déjà enregistrés. */
export function savedKeys(db: Db): Set<string> {
  return new Set(
    db
      .select({ key: settings.key })
      .from(settings)
      .all()
      .map((row) => row.key),
  );
}

/** Version envoyable au navigateur : chaque secret devient `{ set }`, sa valeur ne sort jamais. */
export function maskSetting<K extends SettingKey>(key: K, value: Setting<K>): MaskedSetting<K> {
  return mapFields(key, value, (v) => ({ set: typeof v === 'string' && v !== '' })) as MaskedSetting<K>;
}

/**
 * Le navigateur ne reçoit jamais les secrets enregistrés : un secret vide ou absent dans un formulaire
 * signifie « garder l'actuel ». Seulement vers la même adresse : sinon un appelant pourrait faire envoyer
 * la clé enregistrée à un serveur de son choix (le test d'Emby est public pendant l'amorçage).
 */
export function withStoredSecrets(key: SettingKey, input: unknown, stored: object | null): unknown {
  if (typeof input !== 'object' || input === null || !stored) return input;
  const { url } = input as Fields;
  const storedUrl = (stored as Fields).url;
  if (typeof storedUrl === 'string' && (typeof url !== 'string' || normalizeUrl(url) !== storedUrl)) return input;
  return mapFields(key, input as Fields, (v, field) => (v === undefined || v === '' ? (stored as Fields)[field] : v));
}

/** Réglages d'Emby, indispensables à la connexion des membres. */
export function requireEmby({ db, cryptoKey }: Data): Setting<'emby'> {
  const emby = getSetting(db, cryptoKey, 'emby');
  if (!emby) throw new HttpError(409, "Emby n'est pas encore configuré");
  return emby;
}

/**
 * Serveur multimédia configuré, ou `null`. Migration à la lecture : tant que `mediaServer` n'a jamais été enregistré,
 * l'ancien réglage `emby` en tient lieu (type `emby`), sans rien réécrire en base.
 */
export function getMediaServer(db: Db, cryptoKey: Buffer): Setting<'mediaServer'> | null {
  const stored = getSetting(db, cryptoKey, 'mediaServer');
  if (stored) return stored;
  const emby = getSetting(db, cryptoKey, 'emby');
  return emby && { kind: 'emby', ...emby };
}
