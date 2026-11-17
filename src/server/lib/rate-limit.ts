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

  /** Compte un essai ; renvoie le délai d'attente en ms si la limite est déjà atteinte (l'essai n'est alors pas compté). */
  function hit(key: string, now = Date.now()): { retryAfterMs: number } | null {
    sweep(now);
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.delete(key);
    const oldest = recent[0];
    const blocked = recent.length >= limit && oldest !== undefined;
    if (!blocked) recent.push(now);
    hits.set(key, recent);
    for (const stale of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(stale);
    }
    return blocked ? { retryAfterMs: oldest + windowMs - now } : null;
  }

  return { hit, size: () => hits.size };
}
