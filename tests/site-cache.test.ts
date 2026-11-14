import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
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
  let app=await buildApp({siteCache:cache});
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
   app=await buildApp({siteCache:await connectSiteCache('unix:'+socket,2)});
   assert.equal((await app.inject(`/sites/${site.site_id}/metadata`)).statusCode,200);
   await new Promise(resolve=>setTimeout(resolve,2200));
   assert.equal((await app.inject(`/sites/${site.site_id}/metadata`)).statusCode,404);
   assert.equal((await app.inject('/sites')).json().length,7);
   const exit=once(server,'exit');server.kill('SIGTERM');await exit;
   assert.equal((await app.inject({method:'POST',url:'/sites',payload})).statusCode,503);
   assert.equal((await app.inject('/sites/Site01')).statusCode,200);
  }finally{await app.close();}
 }finally{
  if(server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
