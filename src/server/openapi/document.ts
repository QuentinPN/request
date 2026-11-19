import { resolve } from 'node:path';
import { z } from 'zod';
import { apiErrorSchema } from '../../shared/api-error.ts';
import { API_KEY_HEADER } from '../../shared/api-keys.ts';
import { API_VERSION } from '../../shared/api-version.ts';
import { CSRF_HEADER, CSRF_VALUE, EMBY_TOKEN_PATH, LOGIN_PATH } from '../../shared/auth.ts';
import { SESSION_COOKIE } from '../plugins/auth.ts';
import {
  type Access,
  COMPONENTS,
  CSRF_ERROR,
  type ErrorCode,
  OPERATIONS,
  type Operation,
  type SuccessBody,
  TAGS,
} from './operations.ts';

/**
 * Document OpenAPI 3.1 de l'API, généré depuis les schémas Zod partagés (`src/shared`) par `z.toJSONSchema` : son
 * dialecte, JSON Schema 2020-12, est celui d'OpenAPI 3.1. Aucune route n'en dépend (voir DECISIONS.md).
 */

type Json = Record<string, unknown>;
type Io = 'input' | 'output';

const SCHEMAS_REF = '#/components/schemas/';
const registry = z.registry<{ id: string }>();
for (const [id, schema] of Object.entries(COMPONENTS)) registry.add(schema, { id });

/** `/api/media/:type/:id` → `/api/media/{type}/{id}`. */
/** Ordre par points de code, identique sur toute machine (`localeCompare` dépend de la locale). */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

/** `$ref` locaux de Zod (`#/$defs/X`) → composants du document. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string' ? item.replace(/^#\/\$defs\//, SCHEMAS_REF) : rewriteRefs(item),
    ]),
  );
}

/**
 * Sorties : un objet Zod ordinaire retire les champs inconnus, mais `toJSONSchema` le déclare fermé
 * (`additionalProperties: false`) en sortie. Ouvert ici : un champ ajouté à une réponse ne casse pas un client généré.
 * Un `z.strictObject` (catchall `never`) reste fermé.
 */
const openObjects: NonNullable<z.core.ToJSONSchemaParams['override']> = ({ zodSchema, jsonSchema }) => {
  const def = zodSchema._zod.def;
  if (def.type === 'object' && def.catchall === undefined) delete jsonSchema.additionalProperties;
};

/** Construit le document ; chaque appel repart de zéro (aucun état partagé entre deux appels). */
export function buildOpenApi(): Json {
  const components = new Map<string, { json: Json; text: string }>();

  /** Schéma JSON d'un schéma Zod ; ses composants nommés sont rangés dans `components`. */
  function toJson(schema: z.ZodType, io: Io): Json {
    const {
      $schema: _,
      $defs,
      ...root
    } = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io,
      // Un type sans équivalent JSON (date, transformation en sortie…) fait échouer la génération, jamais un `{}` muet.
      unrepresentable: 'throw',
      metadata: registry,
      ...(io === 'output' && { override: openObjects }),
    }) as Json;
    for (const [id, def] of Object.entries(($defs ?? {}) as Record<string, unknown>)) {
      const json = rewriteRefs(def) as Json;
      const text = JSON.stringify(json);
      const known = components.get(id);
      if (known && known.text !== text)
        throw new Error(`Composant OpenAPI « ${id} » : deux formes différentes (schéma lu en entrée et en sortie ?)`);
      components.set(id, { json, text });
    }
    return rewriteRefs(root) as Json;
  }

  const jsonContent = (schema: z.ZodType) => ({ 'application/json': { schema: toJson(schema, 'output') } });
  const errorContent = { 'application/json': { schema: toJson(apiErrorSchema, 'output') } };
  const imageContent = (types: Iterable<string>) =>
    Object.fromEntries(
      [...new Set(types)].sort(byCodePoint).map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
    );

  /** Paramètres de chemin ou de requête, un par propriété du schéma d'entrée. */
  function parameters(schema: z.ZodType | undefined, location: 'path' | 'query'): Json[] {
    if (!schema) return [];
    const json = toJson(schema, 'input');
    if (json.type !== 'object' || typeof json.properties !== 'object')
      throw new Error(`Paramètres de ${location} : un objet simple est attendu`);
    const required = new Set((json.required as string[] | undefined) ?? []);
    return Object.entries(json.properties as Record<string, Json>).map(([name, schema]) => ({
      name,
      in: location,
      required: location === 'path' || required.has(name),
      schema,
    }));
  }

  const SUCCESS_DESCRIPTIONS: Record<number, string> = { 200: 'Succès', 201: 'Créé', 204: 'Aucun contenu' };

  function success(code: number, body: SuccessBody): Json {
    if (body !== null && 'images' in body) return { description: body.description, content: imageContent(body.images) };
    const { description, schema } =
      body !== null && !('_zod' in body) ? body : { description: SUCCESS_DESCRIPTIONS[code] ?? 'Succès', schema: body };
    return schema ? { description, content: jsonContent(schema) } : { description };
  }

  /** Erreurs déduites de l'opération, puis les siennes (descriptions jointes pour un même code). */
  function errors(op: Operation): Partial<Record<ErrorCode, string>> {
    const found: Partial<Record<ErrorCode, string[]>> = {};
    const add = (code: ErrorCode, description: string) => {
      found[code] = [...(found[code] ?? []), description];
    };
    if (op.params || op.query || op.body) add(400, 'Requête invalide : paramètres, requête ou corps hors du schéma');
    const secured = op.access === undefined || op.access === 'any' || op.access === 'session';
    if (secured) add(401, 'Connexion requise, ou justificatif invalide, expiré ou révoqué');
    if (secured && op.method !== 'get') add(403, CSRF_ERROR);
    for (const [code, description] of Object.entries(op.errors ?? {})) add(Number(code) as ErrorCode, description);
    return Object.fromEntries(Object.entries(found).map(([code, list]) => [code, list.join(' ; ')]));
  }

  const SESSION = [{ cookieAuth: [] }, { bearerAuth: [] }];
  /** `any` : la sécurité globale du document (l'un des trois justificatifs). */
  const SECURITY: Record<Access, Json[] | undefined> = {
    any: undefined,
    session: SESSION,
    optional: [{}, ...SESSION],
    public: [],
  };

  function operation(op: Operation): Json {
    const params = [...parameters(op.params, 'path'), ...parameters(op.query, 'query')];
    const security = SECURITY[op.access ?? 'any'];
    return {
      operationId: op.operationId,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description && { description: op.description }),
      ...(security && { security }),
      ...(params.length > 0 && { parameters: params }),
      ...(op.body && {
        requestBody: {
          required: !op.bodyOptional,
          content: { 'application/json': { schema: toJson(op.body, 'input') } },
        },
      }),
      responses: {
        ...Object.fromEntries(
          Object.entries(op.responses).map(([code, body]) => [code, success(Number(code), body as SuccessBody)]),
        ),
        ...Object.fromEntries(
          Object.entries(errors(op)).map(([code, description]) => [code, { description, content: errorContent }]),
        ),
      },
    };
  }

  const paths: Record<string, Json> = {};
  for (const op of OPERATIONS) {
    const path = toOpenApiPath(op.path);
    paths[path] = { ...paths[path], [op.method]: operation(op) };
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Request',
      version: API_VERSION,
      description:
        'API REST d’Request : demandes de films et de séries des membres d’un serveur Emby, Jellyfin ou Plex. ' +
        'Erreurs : JSON `{ "error": "message" }`. Un seul justificatif par requête (cookie, Bearer ou clé d’API) : ' +
        'plusieurs → 400. Justificatif en en-tête invalide → 401, puis 429 (en-tête `Retry-After`) après des essais ' +
        'répétés depuis la même adresse.',
    },
    tags: Object.entries(TAGS).map(([name, description]) => ({ name, description })),
    security: [...SESSION, { apiKeyAuth: [] }],
    paths,
    components: {
      schemas: Object.fromEntries(
        [...components.entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([id, { json }]) => [id, json]),
      ),
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description:
            `Navigateur : cookie de session signé posé par \`POST ${LOGIN_PATH}\`. Toute écriture (POST, PUT, PATCH, ` +
            `DELETE) exige aussi l’en-tête \`${CSRF_HEADER}: ${CSRF_VALUE}\` et une origine absente ou identique à ` +
            'l’hôte, sinon 403.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            `Client natif : jeton de session renvoyé par \`POST ${EMBY_TOKEN_PATH}\`, dans ` +
            '`Authorization: Bearer <jeton>`. Droits réels du membre ; pas de contrôle CSRF.',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: API_KEY_HEADER,
          description:
            'Script ou outil externe : clé d’API créée par le propriétaire (Réglages › API), qui agit avec les droits ' +
            'de son créateur. Pas de contrôle CSRF.',
        },
      },
    },
  };
}

/** Fichier commité du document, réécrit par `npm run openapi`. */
export const OPENAPI_FILE = resolve(import.meta.dirname, '../../../docs/openapi.json');

/** Le document tel qu'il est écrit dans `OPENAPI_FILE` : indenté, fin de ligne finale. */
export const openApiJson = () => `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
