import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {InputError,type Options,type Site} from './domain.js';
import type {SiteCache,CachedSite} from './site-cache.js';
export interface GenerationRequest {site_id:string;coordinates:Site['coordinates'];start_utc:string;end_utc:string;observer_height_m:number}
export interface GeneratedProduct {site:Site;heightmap_base64:string}
export type SiteGenerator=(request:GenerationRequest)=>Promise<GeneratedProduct>;
export const DEFAULT_START='2026-11-01T00:00:00Z';
export const DEFAULT_END='2026-12-31T23:00:00Z';
export function generationRange(options:Options={}) {
 const start=options.start_utc ?? DEFAULT_START,end=options.end_utc ?? DEFAULT_END,height=options.observer_height_m ?? 2;
 for(const date of [start,end])if(!/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().replace('.000Z','Z')!==date)throw new InputError('Fechas UTC inválidas o sin alineación horaria');
 if(Date.parse(end)<=Date.parse(start)||Date.parse(end)-Date.parse(start)>62*86400000)throw new InputError('El rango debe ser positivo y de hasta 62 días');
 if(![2,5].includes(height))throw new InputError('Altura admitida: 2 o 5 m');
 const step=options.step_hours ?? 1;
 if(!Number.isInteger(step)||step<1||step>24)throw new InputError('Paso fuera de 1–24 horas');
 return {start_utc:start,end_utc:end,observer_height_m:height};
}
function covers(product:GeneratedProduct,range:ReturnType<typeof generationRange>) {
 const site=product.site;
 return Boolean(site.horizon_profiles[String(range.observer_height_m)])&&site.ephemeris_timeline[0].timestamp_utc<=range.start_utc&&site.ephemeris_timeline.at(-1)!.timestamp_utc>=range.end_utc;
}
export const pythonSiteGenerator:SiteGenerator=async request=>{
 const python=process.env.PYTHON_BIN ?? (existsSync(resolve('.venv/bin/python'))?resolve('.venv/bin/python'):'python3');
 const stdout=await new Promise<string>((accept,reject)=>{
  const child=execFile(python,[resolve('python/analyse_site.py')],{timeout:240000,killSignal:'SIGKILL',maxBuffer:8*1024*1024},(error,stdout)=>{
   if(error)return reject(new InputError(error.killed?'La generación superó 240 segundos; reintenta con un rango menor':'No se pudo ejecutar Python; revisa PYTHON_BIN y las dependencias',error.killed?504:503));
   accept(stdout);
  });
  child.stdin?.on('error',()=>{});
  child.stdin?.end(JSON.stringify(request));
 });
 let result:GeneratedProduct & {error?:string;status?:number};
 try{result=JSON.parse(stdout);}catch{throw new InputError('Python devolvió un resultado inválido',503);}
 if(result.error)throw new InputError(result.error,[400,422,502,503].includes(result.status ?? 0)?result.status:503);
 validateProduct(result,request);
 return result;
};
export function validateProduct(product:GeneratedProduct,request:GenerationRequest) {
 const site=product?.site,profile=site?.horizon_profiles?.[String(request.observer_height_m)];
 if(!site || site.site_id!==request.site_id || site.coordinates?.latitude!==request.coordinates.latitude || site.coordinates?.longitude!==request.coordinates.longitude || site.target?.observer_height_m!==request.observer_height_m || !Array.isArray(profile)||profile.length!==360||profile.some(v=>!Number.isFinite(v)||v < -90||v>90))throw new InputError('Producto científico incompatible con la solicitud',503);
 const count=(Date.parse(request.end_utc)-Date.parse(request.start_utc))/3600000+1;
 if(site.ephemeris_timeline?.length!==count)throw new InputError('Cobertura generada incompleta',503);
 for(const [i,row] of site.ephemeris_timeline.entries()){
  if(Date.parse(row.timestamp_utc)!==Date.parse(request.start_utc)+i*3600000 || ![row.sun,row.earth].every(b=>b&&Number.isFinite(b.azimuth_deg)&&b.azimuth_deg>=0&&b.azimuth_deg<360&&Number.isFinite(b.elevation_deg)&&b.elevation_deg>=-90&&b.elevation_deg<=90))throw new InputError('Serie generada inválida',503);
 }
 const png=Buffer.from(product.heightmap_base64 ?? '','base64');
 if(png.length<29||png.length>1500000||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png[24]!==16||png[25]!==0)throw new InputError('Heightmap generado inválido',503);
}
export function automaticAnalyses(cache:SiteCache,generator:SiteGenerator=pythonSiteGenerator) {
 const inFlight=new Map<string,Promise<GeneratedProduct>>();
 return async function ensure(site:CachedSite,options:Options={}):Promise<GeneratedProduct>{
  const range=generationRange(options);
  const previous=await cache.getProduct(site.site_id);
  if(previous&&covers(previous,range))return previous;
  const running=inFlight.get(site.site_id);
  if(running){await running;return ensure(site,options);}
  if(inFlight.size>=1)throw new InputError('Otro sitio está siendo calculado; reintenta en unos segundos',429);
  const operation=(async()=>{
   const token=await cache.acquireGeneration(site.site_id);
   if(!token)throw new InputError('Este sitio está siendo calculado por otra solicitud; reintenta en unos segundos',409);
   try{
    const cached=await cache.getProduct(site.site_id);
    if(cached&&covers(cached,range))return cached;
    const request={site_id:site.site_id,coordinates:site.coordinates,...range};
    const product=await generator(request);
    validateProduct(product,request);
    await cache.publishProduct(site.site_id,token,product);
    return product;
   }finally{await cache.releaseGeneration(site.site_id,token);}
  })();
  inFlight.set(site.site_id,operation);
  try{return await operation;}finally{inFlight.delete(site.site_id);}
 };
}
