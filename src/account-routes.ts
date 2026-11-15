import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InputError } from './domain.js';
import { generationRange } from './site-generator.js';
import type { Accounts, MissionInput, SavedSite } from './accounts.js';
const email = { type: 'string', format: 'email', maxLength: 254 };
const name = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' };
const password = { type: 'string', minLength: 15, maxLength: 128 };
const id = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const missionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'site_ids', 'start_utc', 'end_utc'],
  properties: {
    name,
    description: { type: 'string', maxLength: 2000 },
    site_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: id },
    start_utc: { type: 'string', format: 'date-time' },
    end_utc: { type: 'string', format: 'date-time' },
    step_hours: { type: 'integer', minimum: 1, maximum: 24 },
    observer_height_m: { type: 'integer', enum: [2, 5] },
  },
};
export function accountRoutes(
  app: FastifyInstance,
  accounts: Accounts | undefined,
  predefined: Set<string>,
) {
  function store() {
    if (!accounts)
      throw new InputError(
        'Configura DATABASE_URL y aplica la migración PostgreSQL de cuentas',
        503,
      );
    return accounts;
  }
  async function user(r: FastifyRequest) {
    return store().authenticate(r.headers.authorization);
  }
  async function sites(r: FastifyRequest, input: MissionInput) {
    generationRange(input);
    const u = await user(r);
    const result: SavedSite[] = [];
    for (const id of input.site_ids) {
      if (predefined.has(id)) continue;
      const site = await store().site(u.id, id);
      if (!site) throw new InputError('Sitio desconocido', 404);
      result.push(site);
    }
    return result;
  }
  const credentials = {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: { email, password: { type: 'string', minLength: 1, maxLength: 128 } },
  };
  app.post<{ Body: { name: string; email: string; password: string } }>(
    '/auth/register',
    {
      schema: {
        body: {
          ...credentials,
          required: ['name', 'email', 'password'],
          properties: { name, email, password },
        },
      },
    },
    async (r, reply) => {
      await store().throttle('ip:' + r.ip);
      await store().throttle('email:' + r.body.email.trim().toLowerCase());
      return reply
        .code(201)
        .send(await store().register(r.body.name, r.body.email, r.body.password));
    },
  );
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { schema: { body: credentials } },
    async (r) => {
      await store().throttle('ip:' + r.ip);
      await store().throttle('email:' + r.body.email.trim().toLowerCase());
      return store().login(r.body.email, r.body.password);
    },
  );
  app.get('/auth/me', async (r) => user(r));
  app.post('/auth/logout', async (r, reply) => {
    await user(r);
    await store().logout(r.headers.authorization!);
    return reply.code(204).send();
  });
  app.get('/me/sites', async (r) => store().listSites((await user(r)).id));
  app.get('/missions', async (r) => store().listMissions((await user(r)).id));
  app.post<{ Body: MissionInput }>(
    '/missions',
    { schema: { body: missionSchema } },
    async (r, reply) => {
      const u = await user(r);
      return reply
        .code(201)
        .send(await store().createMission(u.id, r.body, await sites(r, r.body)));
    },
  );
  const params = {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id },
  };
  app.get<{ Params: { id: string } }>('/missions/:id', { schema: { params } }, async (r) =>
    store().mission(r.params.id, (await user(r)).id),
  );
  app.put<{ Params: { id: string }; Body: MissionInput }>(
    '/missions/:id',
    { schema: { params, body: missionSchema } },
    async (r) => {
      const u = await user(r);
      await store().mission(r.params.id, u.id);
      return store().updateMission(r.params.id, u.id, r.body, await sites(r, r.body));
    },
  );
  app.get<{ Params: { id: string } }>('/missions/:id/members', { schema: { params } }, async (r) =>
    store().members(r.params.id, (await user(r)).id),
  );
  app.post<{ Params: { id: string }; Body: { email: string } }>(
    '/missions/:id/invitations',
    {
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email'],
          properties: { email },
        },
      },
    },
    async (r, reply) => {
      const result = await store().invite(r.params.id, (await user(r)).id, r.body.email);
      return reply.code(result.created ? 201 : 200).send(result.invitation);
    },
  );
  app.get<{ Params: { id: string } }>(
    '/missions/:id/invitations',
    { schema: { params } },
    async (r) => store().sentInvitations(r.params.id, (await user(r)).id),
  );
  app.get('/invitations', async (r) => store().invitations((await user(r)).id));
  app.post<{ Params: { id: string } }>(
    '/invitations/:id/accept',
    { schema: { params } },
    async (r) => store().acceptInvitation(r.params.id, (await user(r)).id),
  );
  app.post<{ Params: { id: string } }>(
    '/invitations/:id/reject',
    { schema: { params } },
    async (r, reply) => {
      await store().rejectInvitation(r.params.id, (await user(r)).id);
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { id: string; user_id: string } }>(
    '/missions/:id/members/:user_id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'user_id'],
          additionalProperties: false,
          properties: { id, user_id: id },
        },
      },
    },
    async (r, reply) => {
      await store().unshare(r.params.id, (await user(r)).id, r.params.user_id);
      return reply.code(204).send();
    },
  );
  return { user, store };
}
