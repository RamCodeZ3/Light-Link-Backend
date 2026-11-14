import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectSiteCache} from '../src/site-cache.js';
import {RedisStartupError,startupReport} from '../src/startup-errors.js';
test('URL REST de Upstash se rechaza antes de conectar, sin exponer credenciales',async()=>{
 const secret='synthetic-test-secret';
 await assert.rejects(connectSiteCache(`https://default:${secret}@example.invalid`),error=>{
  assert.ok(error instanceof RedisStartupError);
  const report=startupReport(error);
  assert.equal(report.code,'REDIS_URL_PROTOCOL');
  assert.equal(JSON.stringify(report).includes(secret),false);
  return true;
 });
});
test('URL inválida y TTL inválido producen diagnósticos específicos',async()=>{
 await assert.rejects(connectSiteCache('not-a-url'),error=>error instanceof RedisStartupError&&error.code==='REDIS_URL_INVALID');
 await assert.rejects(connectSiteCache('redis://localhost',NaN),error=>error instanceof RedisStartupError&&error.code==='REDIS_TTL_INVALID');
});
test('errores de arranque desconocidos no revelan datos sensibles',()=>{
 const report=startupReport(new Error('redis://default:synthetic-secret@example.invalid:6379'));
 assert.equal(report.code,'APPLICATION_STARTUP_FAILED');assert.equal(JSON.stringify(report).includes('synthetic-secret'),false);
 assert.equal(startupReport({code:'EADDRINUSE'}).code,'EADDRINUSE');
});
