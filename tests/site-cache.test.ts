import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {InputError} from '../src/domain.js';
import type {Site} from '../src/domain.js';
import type {GenerationRequest} from '../src/site-generator.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createClient} from 'redis';
import {buildApp} from '../src/app.js';

test('registro exige Redis y rechaza coordenadas inválidas',async()=>{
 const app=await buildApp();
 try {
  const response=await app.inject({method:'POST',url:'/sites',payload:{name:'Caso de prueba sintético',coordinates:{latitude:-89,longitude:15}}});
  assert.equal(response.statusCode,503);
  for(const payload of [
   {name:' ',coordinates:{latitude:-89,longitude:15}},
   {name:'Prueba',coordinates:{latitude:-91,longitude:15}},
   {name:'Prueba',coordinates:{latitude:-89,longitude:361}},
   {name:'Prueba',coordinates:{latitude:-89}},
   {name:'Prueba',coordinates:{latitude:-89,longitude:15},horizon_mask:[]}
  ])assert.equal((await app.inject({method:'POST',url:'/sites',payload})).statusCode,400);
 }finally{await app.close();}
});

const binary=process.env.TEST_REDIS_SERVER_PATH;
test('Redis real: registro, deduplicación concurrente, lectura tras reinicio, expiración y fallo',{skip:!binary},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'light-link-redis-'));
 const socket=join(dir,'redis.sock');
 const server=spawn(binary!,['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',dir],{stdio:['ignore','pipe','pipe']});
 let output='';
 try {
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Redis no inició: '+output)),10000);
   server.on('error',e=>{clearTimeout(timer);reject(e);});
   server.stdout.on('data',chunk=>{output+=chunk.toString();if(output.includes('ready to accept connections')||output.includes('Ready to accept connections')){clearTimeout(timer);resolve();}});
   server.stderr.on('data',chunk=>{output+=chunk.toString();});
  });
  // Un socket Unix evita conflictos de puerto durante pruebas paralelas.
  const {connectSiteCache}=await import('../src/site-cache.js');
  const cache=await connectSiteCache('unix:'+socket,2);
  const unsupported=async()=>{throw new InputError('Coordenadas de prueba sin cobertura',422);};
  let app=await buildApp({siteCache:cache,siteGenerator:unsupported});
  try {
   const payload={name:'Sitio sintético para probar registro',coordinates:{latitude:-89,longitude:-1}};
   const responses=await Promise.all(Array.from({length:5},()=>app.inject({method:'POST',url:'/sites',payload})));
   assert.equal(responses.filter(r=>r.statusCode===201).length,1);
   assert.equal(responses.filter(r=>r.statusCode===200).length,4);
   const site=responses[0].json();
   assert.equal(site.status,'pending_data');assert.equal(site.coordinates.longitude,359);
   assert.equal(new Set(responses.map(r=>r.json().site_id)).size,1);
   assert.equal((await app.inject(`/sites/${site.site_id}/metadata`)).json().site_id,site.site_id);
   assert.equal((await app.inject(`/sites/${site.site_id}`)).statusCode,422);
   assert.equal((await app.inject({method:'POST',url:'/analyses',payload:{site_id:site.site_id}})).statusCode,422);
   assert.equal((await app.inject(`/sites/${site.site_id}/export?format=csv`)).statusCode,422);
   assert.equal((await app.inject('/sites')).json().length,8);
   const client=createClient({socket:{path:socket,tls:false}});client.on('error',()=>{});await client.connect();
   try{assert.ok(await client.ttl('light-link:v1:sites:'+site.site_id)>0);}finally{await client.close();}
   await app.close();
   app=await buildApp({siteCache:await connectSiteCache('unix:'+socket,2),siteGenerator:unsupported});
   assert.equal((await app.inject(`/sites/${site.site_id}/metadata`)).statusCode,200);
   await new Promise(resolve=>setTimeout(resolve,2200));
   assert.equal((await app.inject(`/sites/${site.site_id}/metadata`)).statusCode,404);
   assert.equal((await app.inject('/sites')).json().length,7);
   await app.close();
   let calls=0;
   const reference=JSON.parse(await readFile('data/sites/Site01.json','utf8')) as Site;
   const png=(await readFile('public/heightmaps/Site01_heightmap_1024.png')).toString('base64');
   const generate=async(request:GenerationRequest)=>{
    calls++;
    await new Promise(resolve=>setTimeout(resolve,30));
    const count=(Date.parse(request.end_utc)-Date.parse(request.start_utc))/3600000+1;
    // Fixture sintética identificada: verifica la integración, no la ciencia.
    return {site:{...reference,site_id:request.site_id,coordinates:request.coordinates,target:{observer_height_m:request.observer_height_m},heightmap_url:`/sites/${request.site_id}/heightmap`,horizon_profiles:{[String(request.observer_height_m)]:Array(360).fill(0)},ephemeris_timeline:Array.from({length:count},(_,i)=>({timestamp_utc:new Date(Date.parse(request.start_utc)+i*3600000).toISOString().replace('.000Z','Z'),sun:{azimuth_deg:0,elevation_deg:1},earth:{azimuth_deg:90,elevation_deg:2}})),provenance:{synthetic_test_fixture:true}},heightmap_base64:png};
   };
   app=await buildApp({siteCache:await connectSiteCache('unix:'+socket,60),siteGenerator:generate});
   const registered=(await app.inject({method:'POST',url:'/sites',payload})).json();
   const body={site_id:registered.site_id,start_utc:'2026-11-14T00:00:00Z',end_utc:'2026-11-14T03:00:00Z'};
   const analyses=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:'/analyses',payload:body})));
   assert.ok(analyses.every(r=>r.statusCode===200));assert.equal(calls,1);
   assert.equal(analyses[0].json().ephemeris_timeline[0].conditions.co_visibility,true);
   assert.equal((await app.inject(`/sites/${body.site_id}/metadata`)).json().status,'ready');
   assert.equal((await app.inject(`/sites/${body.site_id}/heightmap`)).rawPayload[24],16);
   assert.equal((await app.inject({method:'POST',url:'/analyses',payload:{...body,step_hours:3}})).json().ephemeris_timeline.length,2);assert.equal(calls,1);
   await app.close();
   app=await buildApp({siteCache:await connectSiteCache('unix:'+socket,60),siteGenerator:generate});
   assert.equal((await app.inject({method:'POST',url:'/analyses',payload:body})).statusCode,200);assert.equal(calls,1);
   const native5=await app.inject({method:'POST',url:'/analyses',payload:{...body,observer_height_m:5}});
   assert.equal(native5.statusCode,200);assert.equal(calls,2);
   assert.equal(native5.json().resolution.height_method,'native ephemeris observer height');
   assert.equal((await app.inject(`/sites/${body.site_id}/export?start_utc=${body.start_utc}&end_utc=${body.end_utc}&observer_height_m=5&format=csv`)).statusCode,200);assert.equal(calls,2);
   assert.equal((await app.inject({method:'POST',url:'/analyses',payload:{...body,end_utc:'2027-11-14T00:00:00Z'}})).statusCode,400);assert.equal(calls,2);
   const lockCache=await connectSiteCache('unix:'+socket,60);
   try{
    const token=await lockCache.acquireGeneration(body.site_id);assert.ok(token);
    await lockCache.releaseGeneration(body.site_id,'wrong-owner');
    assert.equal(await lockCache.acquireGeneration(body.site_id),null);
    assert.equal((await app.inject({method:'POST',url:'/analyses',payload:body})).statusCode,409);assert.equal(calls,2);
    await lockCache.releaseGeneration(body.site_id,token);
   }finally{await lockCache.close();}
   await app.close();
   app=await buildApp({siteCache:await connectSiteCache('unix:'+socket,60),siteGenerator:async()=>{throw new InputError('Horizons no disponible (prueba)',502);}});
   assert.equal((await app.inject({method:'POST',url:'/analyses',payload:body})).statusCode,502);
   assert.equal((await app.inject(`/sites/${body.site_id}/metadata`)).json().coverage.observer_height_m,5);
   assert.equal((await app.inject({method:'POST',url:'/analyses',payload:{...body,observer_height_m:5}})).statusCode,200);
   assert.equal((await app.inject('/sites/product:custom_invalid/metadata')).statusCode,400);
   const exit=once(server,'exit');server.kill('SIGTERM');await exit;
   assert.equal((await app.inject({method:'POST',url:'/sites',payload})).statusCode,503);
   assert.equal((await app.inject('/sites/Site01')).statusCode,200);
  }finally{await app.close();}
 }finally{
  if(server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
