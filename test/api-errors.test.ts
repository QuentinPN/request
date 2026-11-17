import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { apiErrorHandler } from '../src/server/lib/api-errors.ts';

function appWithBoom() {
  const app = Fastify({ logger: false });
  app.setErrorHandler(apiErrorHandler);
  app.post('/json', async () => ({ ok: true }));
  app.get('/boom', async () => {
    throw new Error('détail interne : /srv/db.sqlite');
  });
  return app;
}

describe('apiErrorHandler', () => {
  it('garde le statut 4xx de Fastify avec un corps { error } en français', async () => {
    const res = await appWithBoom().inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{oups',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Requête invalide' });
  });

  it('une erreur inattendue donne un 500 générique, sans le message brut', async () => {
    const res = await appWithBoom().inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Erreur interne du serveur' });
  });
});
