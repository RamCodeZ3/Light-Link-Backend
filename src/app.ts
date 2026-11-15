import Fastify from 'fastify';
import { connectAccounts, type Accounts } from './accounts.js';
import { accountRoutes } from './account-routes.js';
import { automaticAnalyses, type SiteGenerator } from './site-generator.js';
import { masterSchema } from './schema.js';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { analyse, type Options, InputError } from './domain.js';
import { loadSites } from './repository.js';
import { connectSiteCache, type SiteCache, type NewSite } from './site-cache.js';
const optionProperties = {
  observer_height_m: { type: 'number', enum: [2, 5] },
  start_utc: { type: 'string', format: 'date-time' },
  end_utc: { type: 'string', format: 'date-time' },
  step_hours: { type: 'integer', minimum: 1, maximum: 24 },
};
export async function buildApp(
  config: {
    siteCache?: SiteCache;
    redisUrl?: string;
    siteCacheTtlSeconds?: number;
    siteGenerator?: SiteGenerator;
    accounts?: Accounts;
    databaseUrl?: string;
  } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const repo = await loadSites();
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL;
  const siteCache =
    config.siteCache ??
    (redisUrl
      ? await connectSiteCache(
          redisUrl,
          config.siteCacheTtlSeconds ?? Number(process.env.SITE_CACHE_TTL_SECONDS ?? 86400),
        )
      : undefined);
  if (siteCache)
    app.addHook('onClose', async () => {
      await siteCache.close();
    });
  let accounts = config.accounts;
  try {
    const accountUrl = config.databaseUrl ?? process.env.DATABASE_URL;
    if (!accounts && accountUrl) accounts = await connectAccounts(accountUrl);
  } catch (error) {
    await siteCache?.close();
    throw error;
  }
  if (accounts)
    app.addHook('onClose', async () => {
      await accounts.close();
    });
  const auth = accountRoutes(app, accounts, new Set(repo.list().map((s) => s.site_id)));
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.headers.authorization ||
      request.url.startsWith('/auth/') ||
      request.url.startsWith('/missions') ||
      request.url.startsWith('/invitations') ||
      request.url.startsWith('/me/')
    )
      reply.header('cache-control', 'no-store');
    return payload;
  });
  const ensure = siteCache ? automaticAnalyses(siteCache, config.siteGenerator) : undefined;
  function requireCache() {
    if (!siteCache) throw new InputError('Registro de sitios requiere configurar REDIS_URL', 503);
    return siteCache;
  }
  async function privateSite(id: string, authorization?: string) {
    if (!id.startsWith('custom_')) throw new InputError('Sitio desconocido', 404);
    const u = await auth.store().authenticate(authorization);
    const saved = await auth.store().site(u.id, id);
    if (!saved) throw new InputError('Sitio desconocido', 404);
    // El registro científico es compartido, el nombre pertenece al usuario o misión.
    const cached = await requireCache().register({
      name: 'Sitio calculado',
      coordinates: saved.coordinates,
    });
    return { ...cached.site, name: saved.name };
  }
  async function getAnalysableSite(id: string, options: Options = {}, authorization?: string) {
    const predefined = repo.list().find((s) => s.site_id === id);
    if (predefined) return predefined;
    const pending = await privateSite(id, authorization);
    if (pending) return (await ensure!(pending, options)).site;
    throw new InputError('Sitio desconocido o expirado', 404);
  }
  const params = {
    type: 'object',
    required: ['site_id'],
    properties: { site_id: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' } },
    additionalProperties: false,
  };
  const query = { type: 'object', properties: optionProperties, additionalProperties: false };
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof InputError
        ? error.statusCode
        : (error as { validation?: unknown }).validation
          ? 400
          : 500;
    if (status === 500) request.log.error(error);
    reply.code(status).send({ error: status === 500 ? 'Error interno' : (error as Error).message });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/sites', async () =>
    repo.list().map((s) => ({
      site_id: s.site_id,
      coordinates: s.coordinates,
      observer_heights_m: Object.keys(s.horizon_profiles).map(Number),
      coverage: {
        start_utc: s.ephemeris_timeline[0].timestamp_utc,
        end_utc: s.ephemeris_timeline.at(-1)!.timestamp_utc,
      },
    })),
  );
  app.post<{ Body: NewSite }>(
    '/sites',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'coordinates'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
            coordinates: {
              type: 'object',
              required: ['latitude', 'longitude'],
              additionalProperties: false,
              properties: {
                latitude: { type: 'number', minimum: -90, maximum: 90 },
                longitude: { type: 'number', minimum: -180, maximum: 360 },
              },
            },
          },
        },
      },
    },
    async (r, reply) => {
      const cache = requireCache();
      const u = await auth.user(r);
      const result = await cache.register({
        name: 'Sitio calculado',
        coordinates: r.body.coordinates,
      });
      const created = await auth.store().saveSite(u.id, {
        ...r.body,
        name: r.body.name.trim(),
        site_id: result.site.site_id,
        coordinates: result.site.coordinates,
      });
      result.site = { ...result.site, name: r.body.name.trim() };
      result.created = created === 1;
      return reply
        .code(result.created ? 201 : 200)
        .header('location', `/sites/${result.site.site_id}/metadata`)
        .send(result.site);
    },
  );
  app.get<{ Params: { site_id: string } }>(
    '/sites/:site_id/metadata',
    { schema: { params } },
    async (r) => {
      const predefined = repo.list().find((s) => s.site_id === r.params.site_id);
      if (predefined)
        return {
          site_id: predefined.site_id,
          coordinates: predefined.coordinates,
          status: 'ready',
          source: 'precomputed',
        };
      const site = await privateSite(r.params.site_id, r.headers.authorization);
      if (!site) throw new InputError('Sitio desconocido o expirado', 404);
      return site;
    },
  );
  app.get<{ Params: { site_id: string }; Querystring: Options }>(
    '/sites/:site_id',
    { schema: { params, querystring: query, response: { 200: masterSchema } } },
    async (r) =>
      analyse(await getAnalysableSite(r.params.site_id, r.query, r.headers.authorization), r.query),
  );
  app.post<{ Body: Options & { site_id: string } }>(
    '/analyses',
    {
      schema: {
        response: { 200: masterSchema },
        body: {
          type: 'object',
          required: ['site_id'],
          properties: {
            site_id: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
            ...optionProperties,
          },
          additionalProperties: false,
        },
      },
    },
    async (r) =>
      analyse(await getAnalysableSite(r.body.site_id, r.body, r.headers.authorization), r.body),
  );
  app.get<{ Params: { site_id: string }; Querystring: Options & { format?: string } }>(
    '/sites/:site_id/export',
    {
      schema: {
        params,
        querystring: {
          ...query,
          properties: { ...optionProperties, format: { type: 'string', enum: ['json', 'csv'] } },
        },
      },
    },
    async (r, reply) => {
      const result = analyse(
        await getAnalysableSite(r.params.site_id, r.query, r.headers.authorization),
        r.query,
      );
      if (r.query.format === 'csv')
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${result.site_id}-windows.csv"`)
          .send(
            [
              'condition,start_utc,end_utc,duration_hours,truncated_start,truncated_end',
              ...result.windows.map((w) =>
                [
                  w.condition,
                  w.start_utc,
                  w.end_utc,
                  w.duration_hours,
                  w.truncated_start,
                  w.truncated_end,
                ].join(','),
              ),
            ].join('\r\n') + '\r\n',
          );
      return result;
    },
  );
  app.get<{ Params: { site_id: string } }>(
    '/sites/:site_id/heightmap',
    { schema: { params } },
    async (r, reply) => {
      await privateSite(r.params.site_id, r.headers.authorization);
      const product = await requireCache().getProduct(r.params.site_id);
      if (!product)
        throw new InputError(
          'Heightmap no disponible o expirado; solicita el análisis primero',
          404,
        );
      return reply
        .type('image/png')
        .header('cache-control', 'no-store')
        .send(Buffer.from(product.heightmap_base64, 'base64'));
    },
  );
  const allowed = new Set(repo.list().map((s) => basename(s.heightmap_url)));
  app.get<{ Params: { file: string } }>('/assets/heightmaps/:file', async (r, reply) => {
    if (!allowed.has(r.params.file)) throw new InputError('Recurso desconocido', 404);
    return reply
      .type('image/png')
      .header('cache-control', 'public, max-age=3600')
      .send(await readFile(resolve('public/heightmaps', r.params.file)));
  });
  return app;
}
