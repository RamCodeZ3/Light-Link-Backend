import {Pool,type PoolClient} from 'pg';
import {databaseConfig} from './database-config.js';
import {DatabaseStartupError} from './startup-errors.js';
import {createHash,randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import {InputError} from './domain.js';
import type {NewSite} from './site-cache.js';
export type PublicUser={id:string;name:string;email:string};
type User=PublicUser & {password_hash:string};
export type SavedSite=NewSite & {site_id:string};
export type MissionInput={name:string;description?:string;site_ids:string[];start_utc:string;end_utc:string;step_hours?:number;observer_height_m?:number};
export type Mission=MissionInput & {id:string;owner_id:string;sites:SavedSite[];created_at_utc:string;updated_at_utc:string};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const normalize=(email:string)=>email.trim().toLowerCase();
function derive(password:string,salt:string):Promise<Buffer>{return new Promise((resolve,reject)=>scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:160*1024*1024},(error,key)=>error?reject(error):resolve(key)));}
export async function passwordHash(password:string){const salt=randomBytes(16).toString('hex');return `scrypt:${salt}:${(await derive(password,salt)).toString('hex')}`;}
async function verify(password:string,hash:string){const [,salt,key]=hash.split(':');const actual=await derive(password,salt);const expected=Buffer.from(key,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export async function connectAccounts(url:string){
 const pool=new Pool(databaseConfig(url));
 pool.on('error',()=>{});
 try{
  const version=await pool.query("SELECT version FROM schema_migrations WHERE version='001_accounts_missions'");
  if(!version.rowCount)throw new Error('missing migration');
 }catch{await pool.end();throw new DatabaseStartupError('DATABASE_CONNECTION_FAILED','PostgreSQL no disponible o migración 001 pendiente; revisa DATABASE_URL, certificados, puerto y acceso de red');}
 async function run<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch(error){if(error instanceof InputError)throw error;throw new InputError('Almacenamiento PostgreSQL no disponible',503);}}
 async function transaction<T>(fn:(client:PoolClient)=>Promise<T>){return run(async()=>{
  const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });}
 const publicUser=({id,name,email}:User):PublicUser=>({id,name,email});
 async function findUser(email:string):Promise<User|undefined>{return run(async()=>(await pool.query('SELECT id,name,email,password_hash FROM users WHERE email=$1',[normalize(email)])).rows[0]);}
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 function missionId(id:string){if(!uuid.test(id))throw new InputError('Misión desconocida',404);}
 const missionSelect=`SELECT m.*,
  COALESCE((SELECT jsonb_agg(s.site_id ORDER BY s.position) FROM mission_sites s WHERE s.mission_id=m.id),'[]'::jsonb) AS site_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('site_id',s.site_id,'name',s.name,'coordinates',jsonb_build_object('latitude',s.latitude,'longitude',s.longitude)) ORDER BY s.position) FROM mission_sites s WHERE s.mission_id=m.id AND s.name IS NOT NULL),'[]'::jsonb) AS sites
  FROM missions m`;
 function decode(row:Record<string,unknown>):Mission{
  const result={...row};for(const k of ['start_utc','end_utc','created_at_utc','updated_at_utc'])result[k]=(row[k] as Date).toISOString().replace('.000Z','Z');return result as unknown as Mission;
 }
 async function mission(id:string,userId:string,write=false):Promise<Mission>{
  missionId(id);return run(async()=>{
   const result=await pool.query(missionSelect+` WHERE m.id=$1 AND (m.owner_id=$2 OR EXISTS(SELECT 1 FROM mission_members mm WHERE mm.mission_id=m.id AND mm.user_id=$2 AND ($3::boolean=false OR mm.role='editor')))`,[id,userId,write]);
   if(!result.rowCount)throw new InputError('Misión desconocida',404);return decode(result.rows[0]);
  });
 }
 async function writeSites(client:PoolClient,id:string,input:MissionInput,sites:SavedSite[]){
  for(const [position,siteId] of input.site_ids.entries()){
   const s=sites.find(s=>s.site_id===siteId);
   await client.query('INSERT INTO mission_sites(mission_id,site_id,position,name,latitude,longitude) VALUES($1,$2,$3,$4,$5,$6)',[id,siteId,position,s?.name ?? null,s?.coordinates.latitude ?? null,s?.coordinates.longitude ?? null]);
  }
 }
 // Hash constante para que un correo inexistente también requiera scrypt.
 const dummy='scrypt:00000000000000000000000000000000:'+Buffer.alloc(64).toString('hex');
 let hashing=0;
 async function limited<T>(fn:()=>Promise<T>){if(hashing>=2)throw new InputError('Autenticación ocupada; reintenta',429);hashing++;try{return await fn();}finally{hashing--;}}
 return {
  async throttle(identity:string){await run(async()=>{
   await pool.query('DELETE FROM auth_rate_limits WHERE expires_at<=now()');
   const result=await pool.query(`INSERT INTO auth_rate_limits(identity_hash,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes')
    ON CONFLICT(identity_hash) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at<=now() THEN 1 ELSE auth_rate_limits.attempts+1 END,
    expires_at=CASE WHEN auth_rate_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING attempts`,[digest(identity)]);
   if(result.rows[0].attempts>20)throw new InputError('Demasiados intentos; reintenta en 15 minutos',429);
  });},
  async register(name:string,email:string,password:string){return limited(async()=>{
   const user:User={id:randomUUID(),name:name.trim(),email:normalize(email),password_hash:await passwordHash(password)};
   await run(async()=>{try{await pool.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user.id,user.name,user.email,user.password_hash]);}catch(error){if((error as {code?:string}).code==='23505')throw new InputError('No se pudo registrar la cuenta con ese correo',409);throw error;}});
   return publicUser(user);
  });},
  async login(email:string,password:string){return limited(async()=>{
   const user=await findUser(email);const valid=await verify(password,user?.password_hash ?? dummy);
   if(!user||!valid)throw new InputError('Correo o contraseña incorrectos',401);
   const token=randomBytes(32).toString('base64url');
   await run(async()=>{await pool.query('DELETE FROM sessions WHERE expires_at<=now()');await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",[digest(token),user.id]);});
   return {user:publicUser(user),access_token:token,token_type:'Bearer',expires_in:86400};
  });},
  async authenticate(header?:string){
   if(!header||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))throw new InputError('Se requiere iniciar sesión',401);
   return run(async()=>{const result=await pool.query('SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(header.slice(7))]);if(!result.rowCount)throw new InputError('Sesión inválida o expirada',401);return result.rows[0] as PublicUser;});
  },
  async logout(header:string){await run(()=>pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(header.slice(7))]));},
  async saveSite(userId:string,site:SavedSite){return transaction(async client=>{
   const values=[userId,site.site_id,site.name,site.coordinates.latitude,site.coordinates.longitude];
   const inserted=await client.query('INSERT INTO user_sites(user_id,site_id,name,latitude,longitude) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING site_id',values);
   if(inserted.rowCount)return 1;
   await client.query('UPDATE user_sites SET name=$3,latitude=$4,longitude=$5 WHERE user_id=$1 AND site_id=$2',values);return 0;
  });},
  async listSites(userId:string):Promise<SavedSite[]>{return run(async()=>(await pool.query("SELECT site_id,name,jsonb_build_object('latitude',latitude,'longitude',longitude) AS coordinates FROM user_sites WHERE user_id=$1 ORDER BY created_at,site_id",[userId])).rows);},
  async site(userId:string,id:string):Promise<SavedSite|null>{return run(async()=>{
   const own=await pool.query("SELECT site_id,name,jsonb_build_object('latitude',latitude,'longitude',longitude) AS coordinates FROM user_sites WHERE user_id=$1 AND site_id=$2",[userId,id]);if(own.rowCount)return own.rows[0];
   const shared=await pool.query(`SELECT s.site_id,s.name,jsonb_build_object('latitude',s.latitude,'longitude',s.longitude) AS coordinates FROM mission_sites s JOIN missions m ON m.id=s.mission_id WHERE s.site_id=$2 AND s.name IS NOT NULL AND (m.owner_id=$1 OR EXISTS(SELECT 1 FROM mission_members mm WHERE mm.mission_id=m.id AND mm.user_id=$1)) ORDER BY m.created_at_utc,m.id LIMIT 1`,[userId,id]);return shared.rows[0] ?? null;
  });},
  async createMission(userId:string,input:MissionInput,sites:SavedSite[]){
   const id=randomUUID();await transaction(async client=>{
    await client.query('INSERT INTO missions(id,owner_id,name,description,start_utc,end_utc,step_hours,observer_height_m) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,userId,input.name.trim(),input.description ?? '',input.start_utc,input.end_utc,input.step_hours ?? 1,input.observer_height_m ?? 2]);await writeSites(client,id,input,sites);
   });return mission(id,userId);
  },
  mission,
  async listMissions(userId:string):Promise<Mission[]>{return run(async()=>(await pool.query(missionSelect+' WHERE m.owner_id=$1 OR EXISTS(SELECT 1 FROM mission_members mm WHERE mm.mission_id=m.id AND mm.user_id=$1) ORDER BY m.created_at_utc,m.id',[userId])).rows.map(decode));},
  async share(id:string,ownerId:string,email:string,role:'viewer'|'editor'){
   const m=await mission(id,ownerId);if(m.owner_id!==ownerId)throw new InputError('Solo el propietario puede compartir',403);
   const user=await findUser(email);if(!user)throw new InputError('El destinatario debe tener una cuenta registrada',400);if(user.id===ownerId)throw new InputError('El propietario ya tiene acceso',400);
   await transaction(async client=>{await client.query('SELECT id FROM missions WHERE id=$1 FOR UPDATE',[id]);await client.query('INSERT INTO mission_members(mission_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(mission_id,user_id) DO UPDATE SET role=EXCLUDED.role',[id,user.id,role]);});return {user_id:user.id,role};
  },
  async unshare(id:string,ownerId:string,userId:string){
   const m=await mission(id,ownerId);if(m.owner_id!==ownerId)throw new InputError('Solo el propietario puede retirar acceso',403);if(userId===ownerId)throw new InputError('No se puede retirar al propietario',400);if(!uuid.test(userId))throw new InputError('Usuario inválido',400);
   await transaction(async client=>{await client.query('SELECT id FROM missions WHERE id=$1 FOR UPDATE',[id]);await client.query('DELETE FROM mission_members WHERE mission_id=$1 AND user_id=$2',[id,userId]);});
  },
  async updateMission(id:string,userId:string,input:MissionInput,sites:SavedSite[]){
   missionId(id);await transaction(async client=>{
    // Compartir, revocar y editar bloquean la misma fila para serializar permisos.
    const locked=await client.query('SELECT owner_id FROM missions WHERE id=$1 FOR UPDATE',[id]);
    if(!locked.rowCount)throw new InputError('Misión desconocida',404);
    if(locked.rows[0].owner_id!==userId){const access=await client.query("SELECT 1 FROM mission_members WHERE mission_id=$1 AND user_id=$2 AND role='editor'",[id,userId]);if(!access.rowCount)throw new InputError('Misión desconocida',404);}
    await client.query('UPDATE missions SET name=$2,description=$3,start_utc=$4,end_utc=$5,step_hours=$6,observer_height_m=$7,updated_at_utc=now() WHERE id=$1',[id,input.name.trim(),input.description ?? '',input.start_utc,input.end_utc,input.step_hours ?? 1,input.observer_height_m ?? 2]);
    await client.query('DELETE FROM mission_sites WHERE mission_id=$1',[id]);await writeSites(client,id,input,sites);
   });return mission(id,userId);
  },
  async close(){await pool.end();}
 };
}
export type Accounts=Awaited<ReturnType<typeof connectAccounts>>;
