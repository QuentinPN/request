import type { z } from 'zod';
import {
  LOG_CAPACITY,
  type LogEntry,
  type LogLevel,
  type LogList,
  logLevels,
  type logsQuerySchema,
} from '../../shared/logs.ts';
import { redactUrl, SECRET_NAMES } from '../integrations/http.ts';

const MASK = '***';
const MAX_MESSAGE = 500;
const MAX_CONTEXT = 2000;
const MAX_DEPTH = 6;

const SECRET_KEY = new RegExp(`^(${SECRET_NAMES})$`, 'i');
/** `nom=valeur`, `nom: valeur`, `"nom":"valeur"` : la valeur est masquée ; sans `\w` ni `-` avant le nom (`monkey=` reste). */
const SECRET_IN_TEXT = new RegExp(
  `(?<![\\w-])(${SECRET_NAMES})(["']?\\s*[=:]\\s*)(["']?)(?:(?:Bearer|Basic)\\s+)?[^&\\s"';,]+`,
  'gi',
);
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;

/** Texte sans valeur de secret : paramètres d'adresse, en-têtes, cookies et jetons `Bearer`. */
export const scrubText = (text: string): string =>
  text.replace(SECRET_IN_TEXT, `$1$2$3${MASK}`).replace(BEARER, `Bearer ${MASK}`);

/** Copie de `value` où toute clé secrète (`token`, `cookie`, `x-api-key`…) est masquée et tout texte expurgé. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '…';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? MASK : scrubValue(item, depth + 1)]),
  );
}

/** Chemin et paramètres d'une adresse de requête, valeurs des paramètres secrets (`?token=`) masquées. */
export function redactRequestUrl(raw: string): string {
  try {
    const url = new URL(redactUrl(new URL(raw, 'http://localhost')));
    return url.pathname + url.search;
  } catch {
    return scrubText(raw);
  }
}

/** Sérialiseur `req` de pino : méthode et adresse expurgée, jamais les en-têtes (cookie, clé d'API, jeton de webhook). */
export const serializeRequest = (req: { method?: string; url?: string }) => ({
  method: req.method,
  url: redactRequestUrl(req.url ?? ''),
});

/** Niveau numérique de pino (10 trace … 60 fatal) → niveau d'affichage. */
const levelOf = (n: unknown): LogLevel => {
  const level = typeof n === 'number' ? n : 30;
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  return level >= 30 ? 'info' : 'debug';
};

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Champs de pino qui ne disent rien de plus que l'entrée elle-même. */
const OMITTED = new Set(['level', 'time', 'pid', 'hostname', 'msg']);

type LogsQuery = z.output<typeof logsQuerySchema>;

/**
 * Journal en mémoire : les `capacity` dernières lignes de pino, expurgées des secrets avant d'être gardées (rien
 * d'autre ne sort de ce tampon). Un par application : `write` est le « flux » que pino remplit, `list` sert la page.
 */
export function createLogBuffer(capacity = LOG_CAPACITY, echo?: (line: string) => void) {
  const entries: LogEntry[] = [];
  let nextId = 1;

  function push(record: Record<string, unknown>) {
    const err = record.err as { message?: unknown } | undefined;
    const message = typeof record.msg === 'string' ? record.msg : typeof err?.message === 'string' ? err.message : '';
    const rest = Object.fromEntries(Object.entries(record).filter(([key]) => !OMITTED.has(key)));
    const context = Object.keys(rest).length > 0 ? JSON.stringify(scrubValue(rest)) : null;
    const entry: LogEntry = {
      id: nextId++,
      time: new Date(typeof record.time === 'number' ? record.time : Date.now()).toISOString(),
      level: levelOf(record.level),
      message: truncate(scrubText(message), MAX_MESSAGE),
      context: context === null ? null : truncate(context, MAX_CONTEXT),
    };
    entries.push(entry);
    if (entries.length > capacity) entries.shift();
    // Même texte expurgé que le tampon, jamais la ligne brute de pino.
    echo?.(`${entry.time} ${entry.level.toUpperCase()} ${entry.message}${entry.context === null ? '' : ` ${entry.context}`}
`);
  }

  return {
    /** Flux de pino : une ligne JSON par appel. Une ligne illisible est ignorée (jamais gardée brute). */
    write(line: string) {
      try {
        push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ligne qui n'est pas du JSON de pino : rien de sûr à garder.
      }
    },
    /** Entrées au niveau demandé ou plus grave dont le message ou le contexte contient `q`, les plus récentes d'abord. */
    list({ level, q, limit }: LogsQuery): LogList {
      const minimum = logLevels.indexOf(level);
      const needle = q.toLowerCase();
      const matching = entries.filter(
        (entry) =>
          logLevels.indexOf(entry.level) >= minimum &&
          (needle === '' || `${entry.message} ${entry.context ?? ''}`.toLowerCase().includes(needle)),
      );
      return { entries: matching.slice(-limit).reverse(), matching: matching.length };
    },
  };
}

export type LogBuffer = ReturnType<typeof createLogBuffer>;
