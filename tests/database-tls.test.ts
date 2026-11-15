import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {databaseConfig} from '../src/database-config.js';
import {startupReport} from '../src/startup-errors.js';
import {temporaryPostgres} from './helpers/postgres.js';
test('TLS: configuración incompleta o inválida falla sin revelar claves',()=>{
 const secret='synthetic-test-private-key';
 for(const [env,code] of [
  [{DATABASE_SSL_KEY:secret},'DATABASE_TLS_CA_MISSING'],
  [{DATABASE_SSL_CA:secret},'DATABASE_TLS_CA_INVALID'],
  [{DATABASE_SSL_CA:secret,DATABASE_SSL_CERT:secret},'DATABASE_TLS_CLIENT_INCOMPLETE']
 ] as const){
  assert.throws(()=>databaseConfig('postgresql://app:synthetic-password@127.0.0.1/db',env),error=>{const report=startupReport(error);assert.equal(report.code,code);assert.ok(!JSON.stringify(report).includes(secret));assert.ok(!JSON.stringify(report).includes('synthetic-password'));return true;});
 }
});
test('TLS PostgreSQL real: CA, certificado de cliente, consulta cifrada y rechazo de configuración insegura',{skip:!process.env.TEST_POSTGRES},async()=>{
 const database=await temporaryPostgres({tlsIp:'127.0.0.1'});
 try{
  const ca=await readFile(join(database.tlsDirectory,'ca.crt'),'utf8');
  const cert=await readFile(join(database.tlsDirectory,'client/client.crt'),'utf8');
  const key=await readFile(join(database.tlsDirectory,'client/client.key'),'utf8');
  const env={DATABASE_SSL_CA:ca,DATABASE_SSL_CERT:cert,DATABASE_SSL_KEY:key};
  const wrongKey=await readFile(join(database.tlsDirectory,'server/server.key'),'utf8');
  for(const [values,code] of [
   [{...env,DATABASE_SSL_CERT:'synthetic-invalid-certificate'},'DATABASE_TLS_CERT_INVALID'],
   [{...env,DATABASE_SSL_KEY:'synthetic-invalid-key'},'DATABASE_TLS_KEY_INVALID'],
   [{...env,DATABASE_SSL_KEY:wrongKey},'DATABASE_TLS_KEY_MISMATCH']
  ] as const){
   assert.throws(()=>databaseConfig(database.tlsUrl,values),error=>{const report=startupReport(error);assert.equal(report.code,code);for(const value of Object.values(values))assert.ok(!JSON.stringify(report).includes(value));return true;});
  }
  const config=databaseConfig(database.tlsUrl,env);
  assert.equal(typeof config.ssl,'object');
  const pool=new Pool(config);
  try{const result=await pool.query('SELECT ssl,client_dn FROM pg_stat_ssl WHERE pid=pg_backend_pid()');assert.equal(result.rows[0].ssl,true);assert.match(result.rows[0].client_dn,/CN=light_link_app/);}finally{await pool.end();}
  for(const suffix of ['?sslmode=disable','?sslmode=require','?sslrootcert=ignored','?ssl=false'])assert.throws(()=>databaseConfig(database.tlsUrl+suffix,env),{code:'DATABASE_TLS_CONFLICT'});
  // Vercel admite PEM multilínea o con saltos escapados.
  const escaped=databaseConfig(database.tlsUrl,Object.fromEntries(Object.entries(env).map(([k,v])=>[k,v.replace(/\n/g,'\\n')])));
  const escapedPool=new Pool(escaped);try{await escapedPool.query('SELECT 1');}finally{await escapedPool.end();}
  const noClient=new Pool(databaseConfig(database.tlsUrl,{DATABASE_SSL_CA:ca}));
  try{await assert.rejects(noClient.query('SELECT 1'),/certificate/i);}finally{await noClient.end();}
  // Sin la CA privada el cliente no confía en el servidor.
  const untrusted=new Pool({connectionString:database.tlsUrl,ssl:{rejectUnauthorized:true,cert,key},connectionTimeoutMillis:3000});
  try{await assert.rejects(untrusted.query('SELECT 1'),/certificate|self.signed/i);}finally{await untrusted.end();}
 }finally{await database.close();}
});
test('TLS PostgreSQL real: rechaza servidor con SAN de otra IP',{skip:!process.env.TEST_POSTGRES},async()=>{
 const database=await temporaryPostgres({tlsIp:'127.0.0.2'});
 try{
  const env={DATABASE_SSL_CA:await readFile(join(database.tlsDirectory,'ca.crt'),'utf8'),DATABASE_SSL_CERT:await readFile(join(database.tlsDirectory,'client/client.crt'),'utf8'),DATABASE_SSL_KEY:await readFile(join(database.tlsDirectory,'client/client.key'),'utf8')};
  const pool=new Pool(databaseConfig(database.tlsUrl,env));try{await assert.rejects(pool.query('SELECT 1'),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});}finally{await pool.end();}
 }finally{await database.close();}
});
