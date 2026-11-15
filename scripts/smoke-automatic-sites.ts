/** Prueba explícita con LOLA local, NASA/JPL y un Redis temporal real. */
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {temporaryPostgres} from '../tests/helpers/postgres.js';
import {buildApp} from '../src/app.js';
import {connectSiteCache} from '../src/site-cache.js';
import {pythonSiteGenerator} from '../src/site-generator.js';
const binary=process.env.TEST_REDIS_SERVER_PATH;
if(!binary)throw new Error('Configura TEST_REDIS_SERVER_PATH con la ruta a redis-server');
const database=await temporaryPostgres();
const directory=await mkdtemp(join(tmpdir(),'light-link-live-'));
const socket=join(directory,'redis.sock');
const server=spawn(binary,['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',directory]);
try {
 await new Promise<void>((resolve,reject)=>{
  let output='';
  const timer=setTimeout(()=>reject(new Error('Redis no inició')),10000);
  server.on('error',e=>{clearTimeout(timer);reject(e);});
  server.stdout.on('data',chunk=>{output+=chunk.toString();if(/ready to accept connections/i.test(output)){clearTimeout(timer);resolve();}});
 });
 let generations=0;
 const app=await buildApp({databaseUrl:database.url,siteCache:await connectSiteCache('unix:'+socket,3600),siteGenerator:async request=>{generations++;return pythonSiteGenerator(request);}});
 try {
  const credentials={name:'Prueba local',email:'smoke@example.test',password:'contraseña temporal de prueba'};
  assert.equal((await app.inject({method:'POST',url:'/auth/register',payload:credentials})).statusCode,201);
  const login=await app.inject({method:'POST',url:'/auth/login',payload:{email:credentials.email,password:credentials.password}});
  assert.equal(login.statusCode,200);
  const headers={authorization:`Bearer ${login.json().access_token}`};
  const registration=await app.inject({method:'POST',url:'/sites',headers,payload:{name:'Prueba real: punto nuevo cerca de Connecting Ridge',coordinates:{latitude:-89.46,longitude:222.45}}});
  assert.equal(registration.statusCode,201);
  const id=registration.json().site_id;
  const payload={site_id:id,start_utc:'2026-11-14T00:00:00Z',end_utc:'2026-11-14T03:00:00Z',observer_height_m:2};
  const first=await app.inject({method:'POST',url:'/analyses',headers,payload});
  assert.equal(first.statusCode,200,first.body);
  const result=first.json();
  const second=await app.inject({method:'POST',url:'/analyses',headers,payload});
  assert.equal(second.statusCode,200);assert.equal(generations,1);
  const reusedCache=generations===1;
  const png=await app.inject({url:result.heightmap_url,headers});assert.equal(png.statusCode,200);assert.equal(png.rawPayload[24],16);
  const atFive=await app.inject({method:'POST',url:'/analyses',headers,payload:{...payload,observer_height_m:5}});
  assert.equal(atFive.statusCode,200,atFive.body);assert.equal(generations,2);
  assert.equal(atFive.json().resolution.height_method,'native ephemeris observer height');
  const nativeRequest=atFive.json().provenance.ephemeris.requests[0].parameters.SITE_COORD;
  assert.notEqual(nativeRequest,result.provenance.ephemeris.requests[0].parameters.SITE_COORD);
  assert.notDeepEqual(atFive.json().horizon_mask,result.horizon_mask);
  const outside=(await app.inject({method:'POST',url:'/sites',headers,payload:{name:'Prueba sin cobertura',coordinates:{latitude:-80,longitude:0}}})).json();
  const rejected=await app.inject({method:'POST',url:'/analyses',headers,payload:{...payload,site_id:outside.site_id}});assert.equal(rejected.statusCode,422,rejected.body);
  const evidence={request:payload,http_status:first.statusCode,cache_reuse:reusedCache,coordinates:result.coordinates,target:result.target,horizon_samples:result.horizon_mask.length,timeline:result.ephemeris_timeline,windows:result.windows,heightmap:{url:result.heightmap_url,bytes:png.rawPayload.length,bits:png.rawPayload[24]},five_metre_native_angles:atFive.json().ephemeris_timeline[0],outside_coverage:{http_status:rejected.statusCode,error:rejected.json()},provenance:result.provenance};
  await writeFile(join(tmpdir(),'light-link-automatic-smoke.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({...evidence,provenance:'Metadatos completos en /tmp/light-link-automatic-smoke.json'},null,2));
 }finally{await app.close();}
}finally{
 if(server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await exited;}
 await rm(directory,{recursive:true,force:true});
 await database.close();
}
