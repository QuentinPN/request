import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadOrCreateKey } from '../src/server/crypto.ts';
import { openDataDir, openDb } from '../src/server/db/index.ts';
import { getSetting, setSetting } from '../src/server/services/settings.ts';
import { agentEventKinds } from '../src/shared/notifications.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();

describe('migrations', () => {
  it('créent la table settings et ne se rejouent pas à la réouverture', () => {
    const dir = tempDir();
    const first = openDataDir(dir);
    const tables = first.db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'settings'")
      .all();
    expect(tables).toHaveLength(1);
    first.db.$client.close();

    const again = openDataDir(dir);
    const applied = again.db.$client.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
    expect(applied.n).toBe(14);
    expect(again.db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    again.db.$client.close();
  });
});

describe('chiffrement', () => {
  const key = randomBytes(32);

  it('rechiffre différemment le même texte et le relit', () => {
    const a = encrypt(key, 'clé-secrète');
    expect(a).not.toBe(encrypt(key, 'clé-secrète'));
    expect(a).not.toContain('clé-secrète');
    expect(decrypt(key, a)).toBe('clé-secrète');
  });

  it('refuse un texte modifié ou une autre clé', () => {
    const payload = encrypt(key, 'abc');
    const [p, iv, tag, data] = payload.split(':');
    const altered = [p, iv, tag, Buffer.from('xyz').toString('base64url')].join(':');
    expect(data).toBeDefined();
    expect(() => decrypt(key, altered)).toThrow();
    expect(() => decrypt(randomBytes(32), payload)).toThrow();
    expect(() => decrypt(key, 'pas-un-secret')).toThrow('Secret chiffré illisible');
  });

  it('crée la clé au premier lancement puis la réutilise', () => {
    const file = join(tempDir(), 'sub', 'secret.key');
    const created = loadOrCreateKey(file);
    expect(existsSync(file)).toBe(true);
    expect(created).toHaveLength(32);
    expect(loadOrCreateKey(file).equals(created)).toBe(true);
  });
});

describe('réglages', () => {
  const cryptoKey = randomBytes(32);
  const raw = (db: ReturnType<typeof openDb>, key: string) =>
    (db.$client.prepare('select value from settings where key = ?').get(key) as { value: string }).value;

  it('chiffrent les secrets en base et les relisent en clair', () => {
    const db = openDb(':memory:');
    const saved = setSetting(db, cryptoKey, 'emby', {
      url: 'http://emby:8096/',
      apiKey: ' abc123 ',
      libraryIds: ['4'],
    });
    expect(saved).toEqual({
      url: 'http://emby:8096',
      apiKey: 'abc123',
      libraryIds: ['4'],
      publicUrl: null,
    });

    const stored = raw(db, 'emby');
    expect(stored).not.toContain('abc123');
    expect(JSON.parse(stored).url).toBe('http://emby:8096');
    expect(getSetting(db, cryptoKey, 'emby')).toEqual(saved);
  });

  it('remplacent la valeur existante', () => {
    const db = openDb(':memory:');
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'ancienne' });
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'nouvelle' });
    expect(getSetting(db, cryptoKey, 'tmdb')).toEqual({ apiKey: 'nouvelle' });
  });

  it('renvoient null si absents et appliquent les valeurs par défaut', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, cryptoKey, 'emby')).toBeNull();
    const discord = { webhookUrl: null, enabled: false, events: agentEventKinds };
    expect(setSetting(db, cryptoKey, 'discord', {})).toEqual(discord);
    expect(getSetting(db, cryptoKey, 'discord')).toEqual(discord);
  });

  it('refusent une valeur invalide sans rien écrire', () => {
    const db = openDb(':memory:');
    expect(() => setSetting(db, cryptoKey, 'emby', { url: 'ftp://emby', apiKey: 'x' })).toThrow();
    expect(() => setSetting(db, cryptoKey, 'emby', { url: 'http://emby:8096', apiKey: '  ' })).toThrow();
    expect(() => setSetting(db, cryptoKey, 'emby', { url: 'http://emby:8096' } as never)).toThrow();
    expect(getSetting(db, cryptoKey, 'emby')).toBeNull();
  });

  it('ne sont pas lisibles avec une autre clé', () => {
    const db = openDb(':memory:');
    setSetting(db, cryptoKey, 'emby', { url: 'http://emby:8096', apiKey: 'k' });
    expect(() => getSetting(db, randomBytes(32), 'emby')).toThrow();
  });

  it('gardent la clé du dossier de données en base64', () => {
    const dir = tempDir();
    const data = openDataDir(dir);
    expect(Buffer.from(readFileSync(join(dir, 'secret.key'), 'utf8'), 'base64').equals(data.cryptoKey)).toBe(true);
    data.db.$client.close();
  });
});
