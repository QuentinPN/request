import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/server/app.ts';
import { createRateLimiter } from '../src/server/lib/rate-limit.ts';

describe('createRateLimiter', () => {
  it('bloque au-delà de la limite puis libère après la fenêtre', () => {
    const { hit } = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(hit('a', 0)).toBeNull();
    expect(hit('a', 100)).toBeNull();
    expect(hit('a', 200)).toEqual({ retryAfterMs: 800 });
    expect(hit('a', 1000)).toBeNull();
  });

  it('purge les clés expirées', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000 });
    for (let i = 0; i < 50; i++) limiter.hit(`ip-${i}`, 0);
    expect(limiter.size()).toBe(50);
    limiter.hit('nouvelle', 2000);
    expect(limiter.size()).toBe(1);
  });

  it('borne le nombre de clés en oubliant les moins récemment actives', () => {
    const { hit, size } = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (const key of ['a', 'b', 'c']) hit(key, 0);
    hit('a', 1); // « a » redevient la plus récente
    hit('d', 2); // « b » est oubliée
    expect(size()).toBe(3);
    expect(hit('a', 3)).not.toBeNull();
    expect(hit('b', 3)).toBeNull();
  });
});

describe('parseTrustProxy', () => {
  it('fait confiance à la boucle locale seule par défaut, plus TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toEqual(['127.0.0.1', '::1']);
    expect(parseTrustProxy(' 172.18.0.2 , 10.0.0.0/8,')).toEqual(['127.0.0.1', '::1', '172.18.0.2', '10.0.0.0/8']);
  });
});
