export interface TtlLruOptions {
  /** Nombre maximal d'entrées ; la moins récemment utilisée part en premier. */
  maxEntries: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Cache mémoire à durée de vie limitée et éviction LRU, avec partage des chargements en cours :
 * deux demandes simultanées de la même clé n'appellent `loader` qu'une fois. Un échec n'est jamais mis en cache.
 */
export class TtlLru<V = unknown> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly loading = new Map<string, Promise<V>>();
  private readonly maxEntries: number;

  constructor({ maxEntries }: TtlLruOptions) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Réinsertion : la clé devient la plus récente.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Oublie une entrée (un chargement en cours n'est pas interrompu). */
  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Valeur en cache, sinon charge-la (une seule fois à la fois par clé) et la garde `ttlMs`. */
  getOrLoad<T extends V>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached as T);
    const pending = this.loading.get(key);
    if (pending) return pending as Promise<T>;
    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }
}
