import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { IntegrationError } from '../integrations/http.ts';

/** Erreur renvoyée telle quelle : statut HTTP et message court, lisible, en français (401, 403, 409, 429…). */
export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/** Requête du client invalide (paramètres, requête ou corps) : la faute est de son côté (une `ZodError` brute est un bug serveur). */
export class BadRequestError extends HttpError {
  constructor() {
    super(400, 'Requête invalide');
    this.name = 'BadRequestError';
  }
}

/** Valide une entrée du client ; lève `BadRequestError` (400) si elle ne correspond pas au schéma. */
export function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestError();
  return parsed.data;
}

/** Un échec du service testé devient une 422 avec son message lisible (aussi pour les serveurs Radarr/Sonarr). */
export async function asTestResult<T>(test: () => Promise<T>): Promise<T> {
  try {
    return await test();
  } catch (error) {
    if (error instanceof IntegrationError) throw new HttpError(422, error.message);
    throw error;
  }
}

/** Un service externe n'a pas encore ses réglages (assistant de configuration non terminé). */
export class NotConfiguredError extends Error {
  constructor(service: string) {
    super(`${service} n'est pas encore configuré`);
    this.name = 'NotConfiguredError';
  }
}

/** Une réponse d'un service externe ne respecte pas notre contrat de sortie : problème amont, pas un bug serveur. */
export class UpstreamContractError extends Error {
  constructor(service: string) {
    super(`Réponse inattendue de ${service}`);
    this.name = 'UpstreamContractError';
  }
}

/** Valide une réponse de `service` avant de l'envoyer ; lève `UpstreamContractError` (502) si elle sort du contrat. */
export function parseUpstream<T>(service: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new UpstreamContractError(service);
  return parsed.data;
}

/**
 * Gestionnaire d'erreurs unique de l'API : `HttpError` (dont `BadRequestError` → 400) → son statut, service
 * non configuré → 503,
 * échec ou réponse hors contrat d'un service externe → 502 (message lisible et sans secret). Erreur 4xx de Fastify
 * (JSON illisible, 404…) → même statut. Le reste est journalisé et devient un 500 générique, jamais le message brut.
 */
export function apiErrorHandler(error: unknown, _req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof NotConfiguredError) return reply.code(503).send({ error: error.message });
  if (error instanceof IntegrationError || error instanceof UpstreamContractError)
    return reply.code(502).send({ error: error.message });
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500)
    return reply.code(status).send({ error: status === 404 ? 'Introuvable' : 'Requête invalide' });
  reply.log.error(error);
  return reply.code(500).send({ error: 'Erreur interne du serveur' });
}
