import { eq } from 'drizzle-orm';
import {
  type Setting,
  type SettingInput,
  type SettingKey,
  secretFields,
  settingSchemas,
} from '../../shared/settings.ts';
import { decrypt, encrypt } from '../crypto.ts';
import type { Db } from '../db/index.ts';
import { settings } from '../db/schema.ts';

type Fields = Record<string, unknown>;

function mapSecrets(key: SettingKey, value: Fields, fn: (s: string) => string): Fields {
  const out = { ...value };
  for (const field of secretFields[key] as readonly string[]) {
    const v = out[field];
    if (typeof v === 'string') out[field] = fn(v);
  }
  return out;
}

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
