import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {connectAccounts} from '../src/accounts.js';
import {temporaryPostgres} from './helpers/postgres.js';

test('cuentas PostgreSQL: unicidad concurrente, persistencia, transacciones, sesión expirada y límite',{skip:!process.env.TEST_POSTGRES},async()=>{
 const database=await temporaryPostgres();
 let accounts:Awaited<ReturnType<typeof connectAccounts>>|undefined;
 try{
  accounts=await connectAccounts(database.url);
  const results=await Promise.allSettled([accounts.register('A','A@EXAMPLE.TEST','contraseña suficientemente larga'),accounts.register('B','a@example.test','contraseña suficientemente larga')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const session=await accounts.login('a@example.test','contraseña suficientemente larga');
  const userId=session.user.id,header='Bearer '+session.access_token;
  await accounts.saveSite(userId,{site_id:'custom_test',name:'Privado',coordinates:{latitude:-89,longitude:0}});
  const input={name:'Persistente',site_ids:['Site01'],start_utc:'2026-11-14T00:00:00Z',end_utc:'2026-11-15T00:00:00Z'};
  const mission=await accounts.createMission(userId,input,[]);
  await accounts.updateMission(mission.id,userId,{...input,name:'Actualizada'},[]);
  assert.ok(Array.isArray((await accounts.mission(mission.id,userId)).sites));
  // Fallar al insertar sitios debe revertir también el cambio de nombre y el DELETE previo.
  await assert.rejects(accounts.updateMission(mission.id,userId,{...input,name:'No debe guardarse',site_ids:['Site01','Site01']},[]),{statusCode:503});
  assert.equal((await accounts.mission(mission.id,userId)).name,'Actualizada');
  assert.deepEqual((await accounts.mission(mission.id,userId)).site_ids,['Site01']);
  await accounts.close();accounts=undefined;await database.restart();
  accounts=await connectAccounts(database.url);
  assert.equal((await accounts.authenticate(header)).id,userId);
  assert.equal((await accounts.listSites(userId))[0].name,'Privado');
  assert.equal((await accounts.mission(mission.id,userId)).name,'Actualizada');
  assert.equal((await accounts.login('A@example.test','contraseña suficientemente larga')).user.id,userId);
  for(let i=0;i<20;i++)await accounts.throttle('test');
  await assert.rejects(accounts.throttle('test'),{statusCode:429});
  const pool=new Pool({connectionString:database.adminUrl});
  try{
   await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[createHash('sha256').update(session.access_token).digest('hex')]);
   await assert.rejects(accounts.authenticate(header),{statusCode:401});
   assert.equal((await pool.query('SELECT count(*)::integer AS n FROM users WHERE id=$1',[userId])).rows[0].n,1);
   assert.equal((await pool.query('SELECT count(*)::integer AS n FROM missions WHERE id=$1',[mission.id])).rows[0].n,1);
   // La migración es repetible y no elimina datos.
   const {readFile}=await import('node:fs/promises');await pool.query(await readFile('migrations/001_accounts_missions.sql','utf8'));
   assert.equal((await accounts.mission(mission.id,userId)).name,'Actualizada');
  }finally{await pool.end();}
 }finally{await accounts?.close();await database.close();}
});
