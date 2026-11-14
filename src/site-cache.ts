import {createClient} from 'redis';
import {RedisStartupError} from './startup-errors.js';
import {createHash,randomUUID} from 'node:crypto';
import type {GeneratedProduct} from './site-generator.js';
import {InputError} from './domain.js';
export interface NewSite {name:string;coordinates:{latitude:number;longitude:number}}
export interface CachedSite extends NewSite {
 site_id:string;status:'pending_data'|'ready';created_at_utc:string;expires_at_utc:string;
 missing_data:string[];
 coverage?:{start_utc:string;end_utc:string;observer_height_m:number};
}
export interface SiteCache {
 register(input:NewSite):Promise<{created:boolean;site:CachedSite}>;
 get(id:string):Promise<CachedSite|null>;
 list():Promise<CachedSite[]>;
 getProduct(id:string):Promise<GeneratedProduct|null>;
 acquireGeneration(id:string):Promise<string|null>;
 publishProduct(id:string,token:string,product:GeneratedProduct):Promise<void>;
 releaseGeneration(id:string,token:string):Promise<void>;
 close():Promise<void>;
}
export async function connectSiteCache(url:string,ttlSeconds=86400,prefix='light-link:v1:sites:'):Promise<SiteCache> {
 if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>2592000)throw new RedisStartupError('REDIS_TTL_INVALID','SITE_CACHE_TTL_SECONDS debe ser entero de 1 a 2592000');
 if(!url.startsWith('unix:')){
  let parsed:URL;
  try{parsed=new URL(url);}catch{throw new RedisStartupError('REDIS_URL_INVALID','REDIS_URL no es una URL válida. Usa la conexión TCP/TLS del proveedor.');}
  if(!['redis:','rediss:'].includes(parsed.protocol))throw new RedisStartupError('REDIS_URL_PROTOCOL','REDIS_URL requiere redis:// o rediss://. La URL https:// de Upstash es REST y no es compatible con este cliente.');
 }
 const socketOptions={connectTimeout:3000,reconnectStrategy:false as const};
 const client=createClient({...url.startsWith('unix:')?{socket:{...socketOptions,path:url.slice(5)}}:{url,socket:socketOptions},disableOfflineQueue:true});
 // Se responde 503 sin exponer credenciales ni datos de conexión.
 client.on('error',()=>{});
 try{await client.connect();}catch(error){
  if(client.isOpen)client.destroy();
  const message=error instanceof Error?error.message:'';
  if(/WRONGPASS|NOAUTH|invalid username-password/i.test(message))throw new RedisStartupError('REDIS_AUTH_FAILED','Redis rechazó la autenticación. Revisa usuario y contraseña en REDIS_URL.');
  throw new RedisStartupError('REDIS_CONNECTION_FAILED','No se pudo conectar a Redis. Revisa host, puerto, TLS, acceso de red y disponibilidad del proveedor.');
 }
 async function run<T>(operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch{throw new InputError('Redis no disponible; no se pudo leer o guardar el sitio',503);}
 }
 async function get(id:string){return run(async()=>{const value=await client.get(prefix+id);return value?JSON.parse(value) as CachedSite:null;});}
 return {
  async register(input){
   const remainder=input.coordinates.longitude%360;
   const longitude=remainder<0?remainder+360:remainder===0?0:remainder;
   const coordinates={latitude:input.coordinates.latitude===0?0:input.coordinates.latitude,longitude};
   const id='custom_'+createHash('sha256').update(JSON.stringify(coordinates)).digest('hex').slice(0,24);
   const now=Date.now();
   const site:CachedSite={site_id:id,name:input.name.trim(),coordinates,status:'pending_data',created_at_utc:new Date(now).toISOString(),expires_at_utc:new Date(now+ttlSeconds*1000).toISOString(),missing_data:['horizon_mask','ephemeris_timeline','heightmap_and_metadata']};
   return run(async()=>{
    // NX evita sobrescribir o renovar accidentalmente el TTL de otro registro.
    for(let attempt=0;attempt<3;attempt++){
     const saved=await client.set(prefix+id,JSON.stringify(site),{EX:ttlSeconds,NX:true});
     if(saved)return {created:true,site};
     const existing=await get(id);
     if(existing)return {created:false,site:existing};
    }
    throw new Error('Registro expiró durante escritura');
   });
  },get,
  async list(){return run(async()=>{
   const sites=new Map<string,CachedSite>();
   for await(const keys of client.scanIterator({MATCH:prefix+'custom_*',COUNT:100})){
    if(!keys.length)continue;
    const values=await client.mGet(keys);
    for(const value of values)if(value){const site=JSON.parse(value) as CachedSite;sites.set(site.site_id,site);}
   }
   return [...sites.values()].sort((a,b)=>a.site_id.localeCompare(b.site_id));
  });},
  async getProduct(id){return run(async()=>{
   if(!await client.exists(prefix+id))return null;
   const value=await client.get(prefix+'product:'+id);
   return value?JSON.parse(value) as GeneratedProduct:null;
  });},
  async acquireGeneration(id){return run(async()=>{
   const token=randomUUID();
   const saved=await client.set(prefix+'lock:'+id,token,{NX:true,EX:300});
   return saved?token:null;
  });},
  async publishProduct(id,token,product){
   const site=await get(id);
   if(!site)throw new InputError('El registro del sitio expiró durante el cálculo; vuelve a registrarlo',404);
   const updated:CachedSite={...site,status:'ready',missing_data:[],expires_at_utc:new Date(Date.now()+ttlSeconds*1000).toISOString(),coverage:{start_utc:product.site.ephemeris_timeline[0].timestamp_utc,end_utc:product.site.ephemeris_timeline.at(-1)!.timestamp_utc,observer_height_m:Number(product.site.target.observer_height_m)}};
   const saved=await run(()=>client.eval("if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4]) redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4]) return 1",{keys:[prefix+'lock:'+id,prefix+id,prefix+'product:'+id],arguments:[token,JSON.stringify(updated),JSON.stringify(product),String(ttlSeconds)]}));
   if(saved!==1)throw new InputError('El registro o bloqueo expiró durante el cálculo; reintenta',409);
  },
  async releaseGeneration(id,token){await run(()=>client.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",{keys:[prefix+'lock:'+id],arguments:[token]}));},
  async close(){if(client.isOpen)await client.close();}
 };
}
