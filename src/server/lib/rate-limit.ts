import type { FastifyReply } from 'fastify';

/**
 * Limiteur en mémoire à fenêtre glissante : au plus `limit` essais par clé (ex. adresse IP) sur `windowMs`.
 * Suffisant pour une instance unique ; tout repart à zéro au redémarrage. La mémoire reste bornée : les clés
 * expirées sont purgées une fois par fenêtre et, au-delà de `maxKeys`, les moins récemment actives sont oubliées.
 */
export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
}: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}) {
  // L'ordre d'insertion de la Map suit la dernière activité : la première clé est la plus ancienne.
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  function sweep(now: number) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, times] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(key);
  }

  /** Essais encore dans la fenêtre pour cette clé. */
  const recentOf = (key: string, now: number) => (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  const retryAfter = (recent: number[], now: number) => {
    const oldest = recent[0];
    return recent.length >= limit && oldest !== undefined ? { retryAfterMs: oldest + windowMs - now } : null;
  };

  /** Compte un essai ; renvoie le délai d'attente en ms si la limite est déjà atteinte (l'essai n'est alors pas compté). */
  function hit(key: string, now = Date.now()): { retryAfterMs: number } | null {
    sweep(now);
    const recent = recentOf(key, now);
    hits.delete(key);
    const blocked = retryAfter(recent, now);
    if (!blocked) recent.push(now);
    hits.set(key, recent);
    for (const stale of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(stale);
    }
    return blocked;
  }

  /** La limite est-elle atteinte pour cette clé ? Ne compte rien : permet de ne compter que les échecs (voir `hit`). */
  const peek = (key: string, now = Date.now()) => retryAfter(recentOf(key, now), now);

  return { hit, peek, size: () => hits.size };
}

/** En-tête `Retry-After` (secondes, arrondi au-dessus) d'un essai refusé par le limiteur. */
export const setRetryAfter = (reply: FastifyReply, { retryAfterMs }: { retryAfterMs: number }) =>
  reply.header('retry-after', Math.ceil(retryAfterMs / 1000));
