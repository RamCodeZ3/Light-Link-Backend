import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { connectAccounts, type Accounts } from '../src/accounts.js';
import { temporaryPostgres } from './helpers/postgres.js';

test(
  'invitaciones: destinatario, persistencia, rechazo, vencimiento, cancelación y concurrencia',
  { skip: !process.env.TEST_POSTGRES },
  async () => {
    const database = await temporaryPostgres();
    let accounts: Accounts | undefined;
    let admin: Pool | undefined;
    try {
      accounts = await connectAccounts(database.url);
      admin = new Pool({ connectionString: database.adminUrl });
      const owner = await accounts.register(
        'Propietario',
        'owner@example.test',
        'synthetic invitation password',
      );
      const member = await accounts.register(
        'Miembro',
        'member@example.test',
        'synthetic invitation password',
      );
      const stranger = await accounts.register(
        'Ajeno',
        'stranger@example.test',
        'synthetic invitation password',
      );
      const input = {
        name: 'Prueba de invitaciones',
        site_ids: ['Site01'],
        start_utc: '2026-11-14T00:00:00Z',
        end_utc: '2026-11-15T00:00:00Z',
      };
      const mission = await accounts.createMission(owner.id, input, []);
      await assert.rejects(accounts.invite(mission.id, owner.id, 'missing@example.test'), {
        statusCode: 400,
      });
      await assert.rejects(accounts.invite(mission.id, owner.id, owner.email), { statusCode: 400 });
      const requests = await Promise.all([
        accounts.invite(mission.id, owner.id, member.email),
        accounts.invite(mission.id, owner.id, member.email),
      ]);
      assert.equal(requests.filter((r) => r.created).length, 1);
      assert.equal(requests[0].invitation.id, requests[1].invitation.id);
      const pendingId = requests[0].invitation.id;
      assert.equal((await accounts.invitations(member.id))[0].id, pendingId);
      assert.equal((await accounts.sentInvitations(mission.id, owner.id)).length, 1);
      assert.deepEqual(await accounts.invitations(stranger.id), []);
      assert.deepEqual(await accounts.members(mission.id, owner.id), []);
      await assert.rejects(accounts.mission(mission.id, member.id), { statusCode: 404 });
      await assert.rejects(accounts.updateMission(mission.id, member.id, input, []), {
        statusCode: 404,
      });
      await assert.rejects(accounts.acceptInvitation(pendingId, stranger.id), { statusCode: 404 });
      await assert.rejects(accounts.rejectInvitation(pendingId, owner.id), { statusCode: 404 });
      // La solicitud pendiente sobrevive al reinicio real de PostgreSQL.
      await accounts.close();
      accounts = undefined;
      await admin.end();
      admin = undefined;
      await database.restart();
      accounts = await connectAccounts(database.url);
      admin = new Pool({ connectionString: database.adminUrl });
      assert.equal((await accounts.invitations(member.id))[0].id, pendingId);
      await accounts.rejectInvitation(pendingId, member.id);
      assert.deepEqual(await accounts.invitations(member.id), []);
      await assert.rejects(accounts.acceptInvitation(pendingId, member.id), { statusCode: 404 });
      await assert.rejects(accounts.mission(mission.id, member.id), { statusCode: 404 });
      const canceled = await accounts.invite(mission.id, owner.id, member.email);
      await accounts.unshare(mission.id, owner.id, member.id);
      await assert.rejects(accounts.acceptInvitation(canceled.invitation.id, member.id), {
        statusCode: 404,
      });
      const expired = await accounts.invite(mission.id, owner.id, member.email);
      await admin.query(
        "UPDATE mission_invitations SET created_at_utc=now()-interval '8 days',expires_at_utc=now()-interval '1 day' WHERE id=$1",
        [expired.invitation.id],
      );
      assert.deepEqual(await accounts.invitations(member.id), []);
      assert.deepEqual(await accounts.sentInvitations(mission.id, owner.id), []);
      await assert.rejects(accounts.acceptInvitation(expired.invitation.id, member.id), {
        statusCode: 404,
      });
      const renewed = await accounts.invite(mission.id, owner.id, member.email);
      assert.equal(renewed.created, true);
      assert.notEqual(renewed.invitation.id, expired.invitation.id);
      await assert.rejects(accounts.acceptInvitation(expired.invitation.id, member.id), {
        statusCode: 404,
      });
      const answers = await Promise.allSettled([
        accounts.acceptInvitation(renewed.invitation.id, member.id),
        accounts.acceptInvitation(renewed.invitation.id, member.id),
      ]);
      assert.equal(answers.filter((r) => r.status === 'fulfilled').length, 1);
      const rejected = answers.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.equal(rejected.reason.statusCode, 404);
      assert.deepEqual(await accounts.members(mission.id, owner.id), [member]);
      assert.deepEqual(await accounts.sentInvitations(mission.id, owner.id), []);
      await assert.rejects(accounts.invite(mission.id, owner.id, member.email), {
        statusCode: 409,
      });
      await accounts.updateMission(
        mission.id,
        member.id,
        { ...input, name: 'Edición compartida' },
        [],
      );
      await assert.rejects(accounts.invite(mission.id, member.id, stranger.email), {
        statusCode: 403,
      });
      await assert.rejects(accounts.members(mission.id, member.id), { statusCode: 403 });
      await assert.rejects(accounts.sentInvitations(mission.id, member.id), { statusCode: 403 });
      await assert.rejects(accounts.unshare(mission.id, member.id, owner.id), { statusCode: 403 });
      await accounts.unshare(mission.id, owner.id, member.id);
      await assert.rejects(accounts.updateMission(mission.id, member.id, input, []), {
        statusCode: 404,
      });
      // Cancelar y aceptar usan el mismo bloqueo: retirar acceso gana al terminar ambas operaciones.
      const last = await accounts.invite(mission.id, owner.id, member.email);
      const raced = await Promise.allSettled([
        accounts.acceptInvitation(last.invitation.id, member.id),
        accounts.unshare(mission.id, owner.id, member.id),
      ]);
      for (const result of raced)
        if (result.status === 'rejected') assert.equal(result.reason.statusCode, 404);
      assert.deepEqual(await accounts.members(mission.id, owner.id), []);
      assert.deepEqual(await accounts.invitations(member.id), []);
      await assert.rejects(accounts.mission(mission.id, member.id), { statusCode: 404 });
    } finally {
      await accounts?.close();
      await admin?.end();
      await database.close();
    }
  },
);
