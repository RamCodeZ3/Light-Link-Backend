import { test } from 'node:test';
import { temporaryPostgres } from './helpers/postgres.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { InputError } from '../src/domain.js';
import type { Site } from '../src/domain.js';
import type { GenerationRequest } from '../src/site-generator.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createClient } from 'redis';
import { buildApp } from '../src/app.js';

test('registro exige Redis y rechaza coordenadas inválidas', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/sites',
      payload: { name: 'Caso de prueba sintético', coordinates: { latitude: -89, longitude: 15 } },
    });
    assert.equal(response.statusCode, 503);
    for (const payload of [
      { name: ' ', coordinates: { latitude: -89, longitude: 15 } },
      { name: 'Prueba', coordinates: { latitude: -91, longitude: 15 } },
      { name: 'Prueba', coordinates: { latitude: -89, longitude: 361 } },
      { name: 'Prueba', coordinates: { latitude: -89 } },
      { name: 'Prueba', coordinates: { latitude: -89, longitude: 15 }, horizon_mask: [] },
    ])
      assert.equal((await app.inject({ method: 'POST', url: '/sites', payload })).statusCode, 400);
  } finally {
    await app.close();
  }
});

const binary = process.env.TEST_REDIS_SERVER_PATH;
test(
  'Redis real: registro, deduplicación concurrente, lectura tras reinicio, expiración y fallo',
  { skip: !binary || !process.env.TEST_POSTGRES },
  async () => {
    const database = await temporaryPostgres();
    const dir = await mkdtemp(join(tmpdir(), 'light-link-redis-'));
    const socket = join(dir, 'redis.sock');
    const server = spawn(
      binary!,
      ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--dir', dir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis no inició: ' + output)), 10000);
        server.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        server.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (
            output.includes('ready to accept connections') ||
            output.includes('Ready to accept connections')
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
        server.stderr.on('data', (chunk) => {
          output += chunk.toString();
        });
      });
      // Un socket Unix evita conflictos de puerto durante pruebas paralelas.
      const { connectSiteCache } = await import('../src/site-cache.js');
      const cache = await connectSiteCache('unix:' + socket, 2);
      const unsupported = async () => {
        throw new InputError('Coordenadas de prueba sin cobertura', 422);
      };
      let app = await buildApp({
        databaseUrl: database.url,
        siteCache: cache,
        siteGenerator: unsupported,
      });
      try {
        const credentials = {
          name: 'Prueba',
          email: 'cache@example.test',
          password: 'contraseña larga de prueba',
        };
        assert.equal(
          (await app.inject({ method: 'POST', url: '/auth/register', payload: credentials }))
            .statusCode,
          201,
        );
        const token = (
          await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: credentialsWithoutName(credentials),
          })
        ).json().access_token;
        const inject = (
          input: string | { method?: 'POST' | 'GET'; url: string; payload?: object },
        ) =>
          app.inject({
            ...(typeof input === 'string' ? { url: input } : input),
            headers: { authorization: `Bearer ${token}` },
          });
        const payload = {
          name: 'Sitio sintético para probar registro',
          coordinates: { latitude: -89, longitude: -1 },
        };
        const responses = await Promise.all(
          Array.from({ length: 5 }, () => inject({ method: 'POST', url: '/sites', payload })),
        );
        assert.equal(responses.filter((r) => r.statusCode === 201).length, 1);
        assert.equal(responses.filter((r) => r.statusCode === 200).length, 4);
        const site = responses[0].json();
        assert.equal(site.status, 'pending_data');
        assert.equal(site.coordinates.longitude, 359);
        assert.equal(new Set(responses.map((r) => r.json().site_id)).size, 1);
        assert.equal(
          (await inject(`/sites/${site.site_id}/metadata`)).json().site_id,
          site.site_id,
        );
        assert.equal((await inject(`/sites/${site.site_id}`)).statusCode, 422);
        assert.equal(
          (await inject({ method: 'POST', url: '/analyses', payload: { site_id: site.site_id } }))
            .statusCode,
          422,
        );
        assert.equal((await inject(`/sites/${site.site_id}/export?format=csv`)).statusCode, 422);
        assert.equal((await inject('/sites')).json().length, 7);
        const client = createClient({ socket: { path: socket, tls: false } });
        client.on('error', () => {});
        await client.connect();
        try {
          assert.ok((await client.ttl('light-link:v1:sites:' + site.site_id)) > 0);
        } finally {
          await client.close();
        }
        await app.close();
        app = await buildApp({
          databaseUrl: database.url,
          siteCache: await connectSiteCache('unix:' + socket, 2),
          siteGenerator: unsupported,
        });
        assert.equal((await inject(`/sites/${site.site_id}/metadata`)).statusCode, 200);
        await new Promise((resolve) => setTimeout(resolve, 2200));
        assert.equal((await inject(`/sites/${site.site_id}/metadata`)).statusCode, 200);
        assert.equal((await inject('/sites')).json().length, 7);
        await app.close();
        let calls = 0;
        const reference = JSON.parse(await readFile('data/sites/Site01.json', 'utf8')) as Site;
        const png = (await readFile('public/heightmaps/Site01_heightmap_1024.png')).toString(
          'base64',
        );
        const generate = async (request: GenerationRequest) => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          const count = (Date.parse(request.end_utc) - Date.parse(request.start_utc)) / 3600000 + 1;
          // Fixture sintética identificada: verifica la integración, no la ciencia.
          return {
            site: {
              ...reference,
              site_id: request.site_id,
              coordinates: request.coordinates,
              target: { observer_height_m: request.observer_height_m },
              heightmap_url: `/sites/${request.site_id}/heightmap`,
              horizon_profiles: { [String(request.observer_height_m)]: Array(360).fill(0) },
              ephemeris_timeline: Array.from({ length: count }, (_, i) => ({
                timestamp_utc: new Date(Date.parse(request.start_utc) + i * 3600000)
                  .toISOString()
                  .replace('.000Z', 'Z'),
                sun: { azimuth_deg: 0, elevation_deg: 1 },
                earth: { azimuth_deg: 90, elevation_deg: 2 },
              })),
              provenance: { synthetic_test_fixture: true },
            },
            heightmap_base64: png,
          };
        };
        app = await buildApp({
          databaseUrl: database.url,
          siteCache: await connectSiteCache('unix:' + socket, 60),
          siteGenerator: generate,
        });
        const registered = (await inject({ method: 'POST', url: '/sites', payload })).json();
        const body = {
          site_id: registered.site_id,
          start_utc: '2026-11-14T00:00:00Z',
          end_utc: '2026-11-14T03:00:00Z',
        };
        const analyses = await Promise.all(
          [1, 2, 3].map(() => inject({ method: 'POST', url: '/analyses', payload: body })),
        );
        assert.ok(analyses.every((r) => r.statusCode === 200));
        assert.equal(calls, 1);
        assert.equal(analyses[0].json().ephemeris_timeline[0].conditions.co_visibility, true);
        // Dos cuentas comparten el cálculo, nunca las listas ni los nombres privados.
        const second = {
          name: 'Equipo B',
          email: 'second@example.test',
          password: 'otra contraseña larga de prueba',
        };
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/auth/register',
              payload: { ...second, password: 'corta' },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/auth/register',
              payload: { ...second, email: 'incorrecto' },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (await app.inject({ method: 'POST', url: '/auth/register', payload: second })).statusCode,
          201,
        );
        const login = (
          await app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: credentialsWithoutName(second),
          })
        ).json();
        const secondHeaders = { authorization: `Bearer ${login.access_token}` };
        assert.equal(
          (await app.inject({ url: `/sites/${body.site_id}/metadata`, headers: secondHeaders }))
            .statusCode,
          404,
        );
        assert.equal(
          (await app.inject({ url: `/sites/${body.site_id}/heightmap`, headers: secondHeaders }))
            .statusCode,
          404,
        );
        assert.equal(
          (await app.inject({ url: `/sites/${body.site_id}`, headers: secondHeaders })).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              url: `/sites/${body.site_id}/export?format=csv`,
              headers: secondHeaders,
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/analyses',
              payload: body,
              headers: secondHeaders,
            })
          ).statusCode,
          404,
        );

        assert.equal(
          (await app.inject({ url: '/me/sites', headers: secondHeaders })).json().length,
          0,
        );
        assert.equal((await app.inject(`/sites/${body.site_id}/metadata`)).statusCode, 401);
        const m = (
          await inject({
            method: 'POST',
            url: '/missions',
            payload: {
              name: 'Misión privada',
              site_ids: [body.site_id, 'Site01'],
              start_utc: body.start_utc,
              end_utc: body.end_utc,
            },
          })
        ).json();
        assert.ok(m.id);
        assert.equal(
          (await app.inject({ url: `/missions/${m.id}`, headers: secondHeaders })).statusCode,
          404,
        );
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: `/missions/${m.id}/invitations`,
              payload: { email: second.email, role: 'viewer' },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: `/missions/${m.id}/invitations`,
              payload: { email: 'not-registered@example.test' },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: `/missions/${m.id}/invitations`,
              payload: { email: credentials.email },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (await app.inject({ url: `/missions/${m.id}/members`, headers: secondHeaders }))
            .statusCode,
          404,
        );
        // La ruta antigua no puede saltarse la aceptación.
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: `/missions/${m.id}/members`,
              payload: { email: second.email },
            })
          ).statusCode,
          404,
        );
        const shared = await inject({
          method: 'POST',
          url: `/missions/${m.id}/invitations`,
          payload: { email: second.email },
        });
        assert.equal(shared.statusCode, 201);
        assert.equal(shared.json().user_id, login.user.id);
        assert.equal(shared.json().status, 'pending');
        assert.equal('role' in shared.json(), false);
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: `/missions/${m.id}/invitations`,
              payload: { email: second.email },
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (await app.inject({ url: `/missions/${m.id}`, headers: secondHeaders })).statusCode,
          404,
        );
        assert.equal(
          (await app.inject({ url: `/sites/${body.site_id}/metadata`, headers: secondHeaders }))
            .statusCode,
          404,
        );
        const inbox = await app.inject({ url: '/invitations', headers: secondHeaders });
        assert.equal(inbox.json()[0].id, shared.json().id);
        assert.equal(inbox.headers['cache-control'], 'no-store');
        assert.equal(
          (await inject(`/missions/${m.id}/invitations`)).json()[0].id,
          shared.json().id,
        );
        assert.equal(
          (await inject({ method: 'POST', url: `/invitations/${shared.json().id}/accept` }))
            .statusCode,
          404,
        );
        const accepted = await app.inject({
          method: 'POST',
          url: `/invitations/${shared.json().id}/accept`,
          headers: secondHeaders,
        });
        assert.equal(accepted.statusCode, 200);
        assert.equal(accepted.json().mission_id, m.id);
        assert.equal(
          (await app.inject({ url: '/invitations', headers: secondHeaders })).json().length,
          0,
        );
        assert.deepEqual((await inject(`/missions/${m.id}/members`)).json(), [login.user]);
        assert.equal(
          (await app.inject({ url: `/missions/${m.id}/members`, headers: secondHeaders }))
            .statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: 'DELETE',
              url: `/missions/${m.id}/members/${m.owner_id}`,
              headers: secondHeaders,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (await app.inject({ url: `/missions/${m.id}`, headers: secondHeaders })).statusCode,
          200,
        );
        assert.equal(
          (await app.inject({ url: `/sites/${body.site_id}/metadata`, headers: secondHeaders }))
            .statusCode,
          200,
        );
        const update = {
          name: 'Cambio autorizado',
          site_ids: [body.site_id],
          start_utc: body.start_utc,
          end_utc: body.end_utc,
        };
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `/missions/${m.id}`,
              headers: secondHeaders,
              payload: update,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/missions/${m.id}/invitations`,
              headers: secondHeaders,
              payload: { email: second.email },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: 'DELETE',
              url: `/missions/${m.id}/members/${login.user.id}`,
              headers: { authorization: `Bearer ${token}` },
            })
          ).statusCode,
          204,
        );
        assert.equal(
          (await app.inject({ url: `/missions/${m.id}`, headers: secondHeaders })).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `/missions/${m.id}`,
              headers: secondHeaders,
              payload: update,
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (await app.inject({ url: `/sites/${body.site_id}/metadata`, headers: secondHeaders }))
            .statusCode,
          404,
        );
        const declined = (
          await inject({
            method: 'POST',
            url: `/missions/${m.id}/invitations`,
            payload: { email: second.email },
          })
        ).json();
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/invitations/${declined.id}/reject`,
              headers: secondHeaders,
            })
          ).statusCode,
          204,
        );
        assert.equal(
          (await app.inject({ url: '/invitations', headers: secondHeaders })).json().length,
          0,
        );
        const canceled = (
          await inject({
            method: 'POST',
            url: `/missions/${m.id}/invitations`,
            payload: { email: second.email },
          })
        ).json();
        assert.equal(
          (
            await app.inject({
              method: 'DELETE',
              url: `/missions/${m.id}/members/${login.user.id}`,
              headers: { authorization: `Bearer ${token}` },
            })
          ).statusCode,
          204,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/invitations/${canceled.id}/accept`,
              headers: secondHeaders,
            })
          ).statusCode,
          404,
        );
        const secondSite = (
          await app.inject({
            method: 'POST',
            url: '/sites',
            headers: secondHeaders,
            payload: { ...payload, name: 'Nombre privado de B' },
          })
        ).json();
        assert.equal(secondSite.site_id, body.site_id);
        const reused = await app.inject({
          method: 'POST',
          url: '/analyses',
          headers: secondHeaders,
          payload: body,
        });
        assert.equal(reused.statusCode, 200);
        assert.equal(calls, 1);
        assert.equal(reused.headers['cache-control'], 'no-store');
        assert.equal((await inject(`/sites/${body.site_id}/metadata`)).json().name, payload.name);
        assert.equal(
          (
            await app.inject({ url: `/sites/${body.site_id}/metadata`, headers: secondHeaders })
          ).json().name,
          'Nombre privado de B',
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/auth/login',
              payload: { email: second.email, password: 'incorrecta' },
            })
          ).statusCode,
          401,
        );
        assert.equal(
          (await app.inject({ method: 'POST', url: '/auth/logout', headers: secondHeaders }))
            .statusCode,
          204,
        );
        assert.equal(
          (await app.inject({ url: '/auth/me', headers: secondHeaders })).statusCode,
          401,
        );

        assert.equal((await inject(`/sites/${body.site_id}/metadata`)).json().status, 'ready');
        assert.equal((await inject(`/sites/${body.site_id}/heightmap`)).rawPayload[24], 16);
        assert.equal(
          (
            await inject({ method: 'POST', url: '/analyses', payload: { ...body, step_hours: 3 } })
          ).json().ephemeris_timeline.length,
          2,
        );
        assert.equal(calls, 1);
        await app.close();
        app = await buildApp({
          databaseUrl: database.url,
          siteCache: await connectSiteCache('unix:' + socket, 60),
          siteGenerator: generate,
        });
        assert.equal(
          (await inject({ method: 'POST', url: '/analyses', payload: body })).statusCode,
          200,
        );
        assert.equal(calls, 1);
        const native5 = await inject({
          method: 'POST',
          url: '/analyses',
          payload: { ...body, observer_height_m: 5 },
        });
        assert.equal(native5.statusCode, 200);
        assert.equal(calls, 2);
        assert.equal(native5.json().resolution.height_method, 'native ephemeris observer height');
        assert.equal(
          (
            await inject(
              `/sites/${body.site_id}/export?start_utc=${body.start_utc}&end_utc=${body.end_utc}&observer_height_m=5&format=csv`,
            )
          ).statusCode,
          200,
        );
        assert.equal(calls, 2);
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: '/analyses',
              payload: { ...body, end_utc: '2027-11-14T00:00:00Z' },
            })
          ).statusCode,
          400,
        );
        assert.equal(calls, 2);
        const lockCache = await connectSiteCache('unix:' + socket, 60);
        try {
          const token = await lockCache.acquireGeneration(body.site_id);
          assert.ok(token);
          await lockCache.releaseGeneration(body.site_id, 'wrong-owner');
          assert.equal(await lockCache.acquireGeneration(body.site_id), null);
          assert.equal(
            (await inject({ method: 'POST', url: '/analyses', payload: body })).statusCode,
            409,
          );
          assert.equal(calls, 2);
          await lockCache.releaseGeneration(body.site_id, token);
        } finally {
          await lockCache.close();
        }
        await app.close();
        app = await buildApp({
          databaseUrl: database.url,
          siteCache: await connectSiteCache('unix:' + socket, 60),
          siteGenerator: async () => {
            throw new InputError('Horizons no disponible (prueba)', 502);
          },
        });
        assert.equal(
          (await inject({ method: 'POST', url: '/analyses', payload: body })).statusCode,
          502,
        );
        assert.equal(
          (await inject(`/sites/${body.site_id}/metadata`)).json().coverage.observer_height_m,
          5,
        );
        assert.equal(
          (
            await inject({
              method: 'POST',
              url: '/analyses',
              payload: { ...body, observer_height_m: 5 },
            })
          ).statusCode,
          200,
        );
        assert.equal((await inject('/sites/product:custom_invalid/metadata')).statusCode, 400);
        const exit = once(server, 'exit');
        server.kill('SIGTERM');
        await exit;
        assert.equal((await inject({ method: 'POST', url: '/sites', payload })).statusCode, 503);
        assert.equal((await inject('/sites/Site01')).statusCode, 200);
      } finally {
        await app.close();
      }
    } finally {
      if (server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
      await database.close();
    }
  },
);

function credentialsWithoutName(value: { email: string; password: string }) {
  return { email: value.email, password: value.password };
}
