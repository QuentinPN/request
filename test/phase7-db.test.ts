import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/server/crypto.ts';
import { migrationsFolder, openDb } from '../src/server/db/index.ts';
import { apiKeys, blockedTitles, issueComments, issues, media, requests, watchlist } from '../src/server/db/schema.ts';
import { getMediaServer, setSetting } from '../src/server/services/settings.ts';
import { PURGE_AFTER_MS, purgeMedia } from '../src/server/services/sync.ts';
import { arrServerInputSchema } from '../src/shared/arr-servers.ts';
import { issueCreateSchema } from '../src/shared/issues.ts';
import { notificationKinds } from '../src/shared/notifications.ts';
import { settingSchemas } from '../src/shared/settings.ts';
import { queryPlan, SLOW_TEST, trackTempDirs, truncatedMigrations } from './helpers.ts';

const tempDir = trackTempDirs();
const cryptoKey = randomBytes(32);

type Db = ReturnType<typeof openDb>;
const run = (db: Db, statement: string, ...params: unknown[]) => db.$client.prepare(statement).run(...params);
const all = (db: Db, statement: string) => db.$client.prepare(statement).all();

/** Base neuve avec un membre `u` et un film `media.id = 1`. */
function seeded() {
  const db = openDb(':memory:');
  run(db, "insert into users (id, name) values ('u', 'U'), ('v', 'V')");
  run(db, "insert into media (id, type, tmdb_id, status, status_updated_at) values (1, 'movie', 10, 'available', 0)");
  return db;
}

const insertServer = (db: Db, type: string, is4k: number, isDefault: number, tags = '[]') =>
  run(
    db,
    `insert into arr_servers (type, name, url, api_key, is_4k, is_default, quality_profile_id, root_folder_path, tags)
     values (?, 'S', 'http://arr', 'v1:x', ?, ?, 1, '/data', ?)`,
    type,
    is4k,
    isDefault,
    tags,
  );

// Ces tests rejouent toutes les migrations : plus de 5 s sur le runner de la CI, d'où un délai explicite de 20 s.
describe('migration 0010 (phase 7) sur une base existante', () => {
  const radarr = { url: 'http://radarr:7878', qualityProfileId: 4, rootFolderPath: '/films' };
  const sonarr = { url: 'http://sonarr:8989', qualityProfileId: 2, rootFolderPath: '/series', languageProfileId: 1 };

  function beforePhase7() {
    const sqlite = new Database(join(tempDir(), 'avant.db'));
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(tempDir(), 10) });
    return sqlite;
  }

  it('conserve les données et reprend les réglages Radarr et Sonarr en serveurs par défaut', SLOW_TEST, () => {
    const sqlite = beforePhase7();
    const settingsRow = sqlite.prepare('insert into settings (key, value) values (?, ?)');
    settingsRow.run('radarr', JSON.stringify({ ...radarr, apiKey: encrypt(cryptoKey, 'cle-radarr') }));
    settingsRow.run(
      'sonarr',
      JSON.stringify({ ...sonarr, apiKey: encrypt(cryptoKey, 'cle-sonarr'), seriesType: 'anime' }),
    );
    sqlite.exec(`
      insert into users (id, name, role) values ('a', 'Alice', 'owner'), ('b', 'Bob', 'member');
      insert into sessions (id, user_id, expires_at) values ('s1', 'b', 1900000000);
      insert into media (id, type, tmdb_id, radarr_id, emby_item_id, status, status_updated_at)
        values (1, 'movie', 10, 7, 'e1', 'available', 1700000000), (2, 'tv', 20, null, null, 'partial', 1700000000);
      insert into seasons (media_id, season_number, status, episodes_present, episodes_expected)
        values (2, 1, 'available', 10, 10);
      insert into requests (id, media_id, user_id, status, is_4k, external_ref)
        values (1, 1, 'b', 'available', 0, null), (2, 2, 'b', 'pending', 1, 'seerr:9');
      insert into request_seasons (request_id, season_number) values (2, 1);
      insert into request_events (request_id, type, actor_id) values (1, 'requested', 'b'), (2, 'requested', 'b');
      insert into notifications (user_id, kind, request_id, detail, read_at) values ('a', 'requested', 2, null, null),
        ('b', 'declined', 1, 'Motif', 1700000100);
    `);
    const snapshot = (table: string) => sqlite.prepare(`select * from ${table} order by rowid`).all();
    const kept = ['request_events', 'seasons'].map((t) => [t, snapshot(t)] as const);
    const sessionsBefore = snapshot('sessions');
    const notificationsBefore = snapshot('notifications');

    migrate(drizzle({ client: sqlite }), { migrationsFolder });

    for (const [table, rows] of kept) expect(snapshot(table)).toEqual(rows);
    // Migration 0016 : les sessions existantes n'ont pas de nom d'appareil.
    expect(snapshot('sessions')).toEqual(sessionsBefore.map((s) => ({ ...(s as object), device_name: null })));
    // Migration 0011 : chaque saison de demande reprend la date de sa demande.
    expect(
      sqlite
        .prepare(
          'select s.request_id, s.season_number, s.created_at = r.created_at as same from request_seasons s join requests r on r.id = s.request_id',
        )
        .all(),
    ).toEqual([{ request_id: 2, season_number: 1, same: 1 }]);
    expect(snapshot('notifications')).toEqual(notificationsBefore.map((n) => ({ ...(n as object), issue_id: null })));
    expect(snapshot('users')).toEqual([
      expect.objectContaining({ id: 'a', role: 'owner', email: null, email_notifications: 1, push_notifications: 1 }),
      expect.objectContaining({ id: 'b', role: 'member' }),
    ]);
    expect(snapshot('media')).toEqual([
      expect.objectContaining({ id: 1, radarr_id: 7, emby_item_id: 'e1', status: 'available', status_4k: null }),
      expect.objectContaining({ id: 2, status: 'partial', radarr_4k_id: null, sonarr_4k_id: null }),
    ]);
    expect(snapshot('requests')).toEqual([
      expect.objectContaining({ id: 1, server_id: null, quota_exempt: 0, created_by: null }),
      expect.objectContaining({ id: 2, is_4k: 1, external_ref: 'seerr:9' }),
    ]);

    const servers = sqlite.prepare('select * from arr_servers order by type').all() as Array<Record<string, unknown>>;
    expect(servers).toEqual([
      expect.objectContaining({
        type: 'radarr',
        name: 'Radarr',
        url: radarr.url,
        is_4k: 0,
        is_default: 1,
        quality_profile_id: 4,
        root_folder_path: '/films',
        minimum_availability: 'released',
        series_type: null,
        language_profile_id: null,
        tags: '[]',
      }),
      expect.objectContaining({
        type: 'sonarr',
        name: 'Sonarr',
        url: sonarr.url,
        is_default: 1,
        quality_profile_id: 2,
        root_folder_path: '/series',
        minimum_availability: null,
        series_type: 'anime',
        language_profile_id: 1,
      }),
    ]);
    // La clé chiffrée est copiée telle quelle : relisible avec la clé du dossier de données.
    expect(servers.map((s) => decrypt(cryptoKey, s.api_key as string))).toEqual(['cle-radarr', 'cle-sonarr']);
    // Les anciens réglages restent lus par le code actuel jusqu'au lot B.
    expect(sqlite.prepare("select count(*) as n from settings where key in ('radarr', 'sonarr')").get()).toEqual({
      n: 2,
    });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    sqlite.close();
  });

  it('ne crée aucun serveur sans réglage Radarr/Sonarr, ni pour un réglage incomplet', SLOW_TEST, () => {
    const sqlite = beforePhase7();
    sqlite.prepare('insert into settings (key, value) values (?, ?)').run('radarr', JSON.stringify({ url: 'x' }));
    migrate(drizzle({ client: sqlite }), { migrationsFolder });
    expect(sqlite.prepare('select count(*) as n from arr_servers').get()).toEqual({ n: 0 });
    sqlite.close();
  });
});

describe('contraintes des nouvelles tables', () => {
  it('arr_servers : type connu, étiquettes en tableau JSON, un seul défaut par type et qualité', () => {
    const db = seeded();
    expect(() => insertServer(db, 'lidarr', 0, 0)).toThrow(/CHECK constraint failed/);
    expect(() => insertServer(db, 'radarr', 0, 0, '{"a":1}')).toThrow(/CHECK constraint failed/);
    expect(() => insertServer(db, 'radarr', 0, 0, 'pas du json')).toThrow(/CHECK constraint failed/);
    insertServer(db, 'radarr', 0, 1, '[3]');
    insertServer(db, 'radarr', 1, 1);
    insertServer(db, 'sonarr', 0, 1);
    insertServer(db, 'radarr', 0, 0);
    expect(() => insertServer(db, 'radarr', 0, 1)).toThrow(/UNIQUE constraint failed/);
    expect(() => insertServer(db, 'radarr', 1, 1)).toThrow(/UNIQUE constraint failed/);
  });

  it('requests : la suppression d’un serveur détache ses demandes ; 4K et normale coexistent', () => {
    const db = seeded();
    insertServer(db, 'radarr', 1, 1);
    const insert = (is4k: number) =>
      run(
        db,
        "insert into requests (media_id, user_id, status, is_4k, server_id) values (1, 'u', 'pending', ?, 1)",
        is4k,
      );
    insert(0);
    insert(1);
    expect(() => insert(1)).toThrow(/UNIQUE constraint failed: requests/);
    run(db, 'delete from arr_servers where id = 1');
    expect(all(db, 'select server_id from requests')).toEqual([{ server_id: null }, { server_id: null }]);
  });

  it('requests.created_by : passe à NULL si l’auteur est supprimé, la demande reste au membre', () => {
    const db = seeded();
    run(db, "insert into requests (media_id, user_id, status, created_by) values (1, 'u', 'pending', 'v')");
    run(db, "delete from users where id = 'v'");
    expect(all(db, 'select user_id, created_by from requests')).toEqual([{ user_id: 'u', created_by: null }]);
  });

  it('media.status_4k : mêmes valeurs que le statut normal', () => {
    const db = seeded();
    expect(() => run(db, "update media set status_4k = 'downloading' where id = 1")).not.toThrow();
    expect(() => run(db, "update media set status_4k = 'perdu' where id = 1")).toThrow(/CHECK constraint failed/);
    expect(() => run(db, "insert into seasons_4k (media_id, season_number, status) values (1, 1, 'perdu')")).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('issues : type et statut connus, épisode avec sa saison, date de résolution si et seulement si résolu', () => {
    const db = seeded();
    const insert = (type: string, status: string, season: number | null, episode: number | null, at: number | null) =>
      run(
        db,
        `insert into issues (media_id, user_id, type, status, season_number, episode_number, message, resolved_at)
         values (1, 'u', ?, ?, ?, ?, 'Pas de son', ?)`,
        type,
        status,
        season,
        episode,
        at,
      );
    expect(() => insert('audio', 'open', 1, 2, null)).not.toThrow();
    expect(() => insert('odeur', 'open', null, null, null)).toThrow(/CHECK constraint failed/);
    expect(() => insert('audio', 'closed', null, null, null)).toThrow(/CHECK constraint failed/);
    expect(() => insert('audio', 'open', null, 2, null)).toThrow(/CHECK constraint failed/);
    expect(() => insert('audio', 'resolved', null, null, null)).toThrow(/CHECK constraint failed/);
    expect(() => insert('audio', 'open', null, null, 1700000000)).toThrow(/CHECK constraint failed/);
    expect(() => insert('audio', 'resolved', null, null, 1700000000)).not.toThrow();
  });

  it('issues : un titre signalé ne peut pas être supprimé ; commentaires supprimés avec leur signalement', () => {
    const db = seeded();
    run(db, "insert into issues (id, media_id, user_id, type, message) values (1, 1, 'u', 'video', 'Saccadé')");
    run(db, "insert into issue_comments (issue_id, user_id, message) values (1, 'v', 'Je regarde')");
    run(db, "insert into notifications (user_id, kind, issue_id) values ('v', 'issue_created', 1)");
    expect(() => run(db, 'delete from media where id = 1')).toThrow(/FOREIGN KEY constraint failed/);
    run(db, "delete from users where id = 'v'");
    expect(all(db, 'select user_id from issue_comments')).toEqual([{ user_id: null }]);
    run(db, 'delete from issues where id = 1');
    expect(all(db, 'select * from issue_comments')).toEqual([]);
  });

  it('notifications : accepte chaque type partagé', () => {
    const db = seeded();
    for (const kind of notificationKinds)
      expect(() => run(db, "insert into notifications (user_id, kind) values ('u', ?)", kind)).not.toThrow();
    expect(() => run(db, "insert into notifications (user_id, kind) values ('u', 'inconnu')")).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('watchlist, blocked_titles, push_subscriptions, api_keys : unicité et valeurs connues', () => {
    const db = seeded();
    const wish = (user: string, source: string) =>
      run(db, "insert into watchlist (user_id, media_type, tmdb_id, source) values (?, 'movie', 10, ?)", user, source);
    wish('u', 'trakt');
    wish('v', 'manual');
    expect(() => wish('u', 'manual')).toThrow(/UNIQUE constraint failed/);
    expect(() => wish('v', 'imdb')).toThrow(/CHECK constraint failed/);

    const block = (type: string) =>
      run(db, "insert into blocked_titles (media_type, tmdb_id, title, blocked_by) values (?, 10, 'T', 'u')", type);
    block('movie');
    block('tv');
    expect(() => block('movie')).toThrow(/UNIQUE constraint failed/);
    expect(() => block('book')).toThrow(/CHECK constraint failed/);

    const subscribe = (user: string) =>
      run(
        db,
        "insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (?, 'https://push/1', 'p', 'a')",
        user,
      );
    subscribe('u');
    expect(() => subscribe('v')).toThrow(/UNIQUE constraint failed/);

    const key = (name: string) =>
      run(db, "insert into api_keys (name, key_hash, prefix, created_by) values (?, 'abc', 'ur_ab', 'u')", name);
    key('Script');
    expect(() => key('Autre')).toThrow(/UNIQUE constraint failed/);

    // Suppression d'un membre : sa liste, ses appareils et ses clés partent avec lui, ses blocages restent.
    run(db, "delete from users where id = 'u'");
    expect(all(db, "select count(*) as n from watchlist where user_id = 'u'")).toEqual([{ n: 0 }]);
    expect(all(db, 'select count(*) as n from push_subscriptions')).toEqual([{ n: 0 }]);
    expect(all(db, 'select count(*) as n from api_keys')).toEqual([{ n: 0 }]);
    expect(all(db, 'select blocked_by from blocked_titles')).toEqual([{ blocked_by: null }, { blocked_by: null }]);
  });
});

describe('purge des titres oubliés', () => {
  it('garde un titre ayant un statut 4K ou un signalement', () => {
    const db = openDb(':memory:');
    run(db, "insert into users (id, name) values ('u', 'U')");
    run(
      db,
      `insert into media (id, type, tmdb_id, status, status_4k, status_updated_at) values
       (1, 'movie', 1, null, null, 0), (2, 'movie', 2, null, 'available', 0), (3, 'movie', 3, null, null, 0)`,
    );
    run(db, "insert into issues (media_id, user_id, type, message) values (3, 'u', 'other', 'x')");
    expect(purgeMedia(db, new Date(Date.now() - PURGE_AFTER_MS))).toBe(1);
    expect(all(db, 'select id from media order by id')).toEqual([{ id: 2 }, { id: 3 }]);
  });
});

describe('index des requêtes prévues', () => {
  const db = openDb(':memory:');
  const since = new Date('2026-01-01T00:00:00Z');
  const month = sql`strftime('%Y-%m', ${requests.createdAt}, 'unixepoch')`;

  it.each([
    [
      'statistiques : demandes par statut',
      () => db.select({ status: requests.status, n: count() }).from(requests).groupBy(requests.status),
      'requests_status_created_at_idx',
    ],
    [
      'statistiques : demandes par mois',
      () => db.select({ month, n: count() }).from(requests).where(gte(requests.createdAt, since)).groupBy(month),
      'requests_created_at_idx',
    ],
    [
      'statistiques : membres les plus actifs',
      () => db.select({ userId: requests.userId, n: count() }).from(requests).groupBy(requests.userId),
      'requests_user_id_created_at_idx',
    ],
    [
      'statistiques : titres les plus demandés',
      () => db.select({ mediaId: requests.mediaId, n: count() }).from(requests).groupBy(requests.mediaId),
      'requests_media_id_status_idx',
    ],
    [
      'signalements ouverts',
      () => db.select({ n: count() }).from(issues).where(eq(issues.status, 'open')),
      'issues_status_created_at_idx',
    ],
    [
      'signalements d’un membre',
      () => db.select().from(issues).where(eq(issues.userId, 'u')).orderBy(desc(issues.createdAt)),
      'issues_user_id_created_at_idx',
    ],
    [
      'signalements d’un titre',
      () =>
        db
          .select()
          .from(issues)
          .where(and(eq(issues.mediaId, 1), eq(issues.status, 'open'))),
      'issues_media_id_status_idx',
    ],
    [
      'fil d’un signalement',
      () => db.select().from(issueComments).where(eq(issueComments.issueId, 1)).orderBy(issueComments.createdAt),
      'issue_comments_issue_id_created_at_idx',
    ],
    [
      'liste de souhaits d’un membre',
      () => db.select().from(watchlist).where(eq(watchlist.userId, 'u')),
      'watchlist_user_id_media_type_tmdb_id_unique',
    ],
    [
      'titre bloqué',
      () =>
        db
          .select()
          .from(blockedTitles)
          .where(and(eq(blockedTitles.mediaType, 'movie'), eq(blockedTitles.tmdbId, 1))),
      'blocked_titles_media_type_tmdb_id_unique',
    ],
    [
      'clé d’API par hash',
      () => db.select().from(apiKeys).where(eq(apiKeys.keyHash, 'abc')),
      'api_keys_key_hash_unique',
    ],
    [
      'suppression d’un titre (clés étrangères)',
      () => db.delete(media).where(eq(media.id, 1)),
      'issues_media_id_status_idx',
    ],
  ])('%s', (_, query, index) => {
    const plan = queryPlan(db, query());
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/SCAN (requests|issues|issue_comments|watchlist|blocked_titles|api_keys)(?! USING)/);
  });

  it('liste des signalements d’un membre sans tri temporaire', () => {
    const plan = queryPlan(db, db.select().from(issues).where(eq(issues.userId, 'u')).orderBy(desc(issues.createdAt)));
    expect(plan).not.toContain('TEMP B-TREE');
  });
});

describe('réglages de la phase 7', () => {
  it('le serveur multimédia retombe sur l’ancien réglage Emby tant qu’il n’est pas enregistré', () => {
    const db = openDb(':memory:');
    expect(getMediaServer(db, cryptoKey)).toBeNull();
    setSetting(db, cryptoKey, 'emby', { url: 'http://emby:8096', apiKey: 'k', libraryIds: ['1'] });
    expect(getMediaServer(db, cryptoKey)).toEqual({
      kind: 'emby',
      url: 'http://emby:8096',
      apiKey: 'k',
      libraryIds: ['1'],
      publicUrl: null,
    });
    setSetting(db, cryptoKey, 'mediaServer', { kind: 'jellyfin', url: 'http://jellyfin:8096', apiKey: 'j' });
    expect(getMediaServer(db, cryptoKey)).toMatchObject({ kind: 'jellyfin', apiKey: 'j' });
    const raw = db.$client.prepare("select value from settings where key = 'mediaServer'").get() as { value: string };
    expect(raw.value).not.toContain('"j"');
  });

  it('valeurs par défaut et validation', () => {
    expect(settingSchemas.discover.parse({})).toEqual({ hideAvailable: false, hideRequested: false });
    expect(settingSchemas.blockedKeywords.parse({})).toEqual({ keywords: [] });
    expect(settingSchemas.smtp.parse({ host: 'smtp.exemple.fr', from: 'appli@exemple.fr' })).toEqual({
      enabled: true,
      host: 'smtp.exemple.fr',
      port: 587,
      security: 'starttls',
      username: null,
      password: null,
      from: 'appli@exemple.fr',
      events: notificationKinds,
    });
    expect(() => settingSchemas.mediaServer.parse({ kind: 'kodi', url: 'http://x', apiKey: 'k' })).toThrow();
    expect(() => settingSchemas.smtp.parse({ host: 'h', from: 'f', port: 70000 })).toThrow();
  });
});

describe('schémas partagés des nouvelles entités', () => {
  it('signalement : un épisode suppose sa saison', () => {
    const base = { type: 'subtitles', mediaType: 'tv', tmdbId: 1, message: ' Décalés ' } as const;
    expect(issueCreateSchema.parse(base)).toEqual({
      ...base,
      message: 'Décalés',
      seasonNumber: null,
      episodeNumber: null,
    });
    expect(issueCreateSchema.safeParse({ ...base, seasonNumber: 1, episodeNumber: 3 }).success).toBe(true);
    expect(issueCreateSchema.safeParse({ ...base, episodeNumber: 3 }).success).toBe(false);
    expect(issueCreateSchema.safeParse({ ...base, message: '  ' }).success).toBe(false);
  });

  it('serveur Radarr/Sonarr : adresse normalisée et valeurs par défaut', () => {
    const input = { type: 'radarr', name: 'Radarr 4K', url: 'http://radarr:7878/', apiKey: 'k', qualityProfileId: 1 };
    expect(arrServerInputSchema.parse({ ...input, rootFolderPath: '/films' })).toEqual({
      ...input,
      url: 'http://radarr:7878',
      rootFolderPath: '/films',
      is4k: false,
      isDefault: false,
      minimumAvailability: null,
      seriesType: null,
      languageProfileId: null,
      tags: [],
      tagRequester: false,
      searchOnAdd: true,
      externalUrl: null,
      animeQualityProfileId: null,
      animeRootFolderPath: null,
      animeSeriesType: null,
      animeLanguageProfileId: null,
      animeTags: [],
    });
    expect(arrServerInputSchema.safeParse({ ...input, type: 'lidarr', rootFolderPath: '/x' }).success).toBe(false);
  });
});
