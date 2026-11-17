import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlLru } from '../src/server/lib/lru.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TtlLru', () => {
  it('garde une valeur jusqu’à la fin de sa durée de vie', () => {
    const cache = new TtlLru<string>({ maxEntries: 10 });
    cache.set('a', 'un', 1000);
    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe('un');
    vi.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('évince l’entrée la moins récemment utilisée', () => {
    const cache = new TtlLru<number>({ maxEntries: 2 });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.get('a');
    cache.set('c', 3, 1000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('getOrLoad ne charge qu’une fois, y compris pour des appels simultanés', async () => {
    const cache = new TtlLru<number>({ maxEntries: 10 });
    const loader = vi.fn(async () => 42);
    const [a, b] = await Promise.all([cache.getOrLoad('k', 1000, loader), cache.getOrLoad('k', 1000, loader)]);
    expect([a, b]).toEqual([42, 42]);
    await cache.getOrLoad('k', 1000, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await cache.getOrLoad('k', 1000, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('ne met pas un échec en cache', async () => {
    const cache = new TtlLru<number>({ maxEntries: 10 });
    const loader = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(7);
    await expect(cache.getOrLoad('k', 1000, loader)).rejects.toThrow('boom');
    await expect(cache.getOrLoad('k', 1000, loader)).resolves.toBe(7);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
