import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import type {PoolConfig} from 'pg';
import {DatabaseStartupError} from './startup-errors.js';
type TlsEnvironment=Partial<Pick<NodeJS.ProcessEnv,'DATABASE_SSL_CA'|'DATABASE_SSL_CERT'|'DATABASE_SSL_KEY'>>;
const invalid=()=>new DatabaseStartupError('DATABASE_TLS_INVALID','Configuración TLS de PostgreSQL inválida. Revisa DATABASE_SSL_CA, DATABASE_SSL_CERT y DATABASE_SSL_KEY.');
function pem(value:string){return value.replace(/\\n/g,'\n').trim()+'\n';}
/** CA privada para Vercel. Conserva validación de cadena e identidad del servidor. */
export function databaseConfig(url:string,env:TlsEnvironment=process.env):PoolConfig{
 const config:PoolConfig={connectionString:url,max:5,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,statement_timeout:10000};
 const ca=env.DATABASE_SSL_CA,cert=env.DATABASE_SSL_CERT,key=env.DATABASE_SSL_KEY;
 if(!ca&&!cert&&!key)return config;
 if(!ca||Boolean(cert)!==Boolean(key))throw invalid();
 let parsed:URL;try{parsed=new URL(url);}catch{throw invalid();}
 // node-postgres puede reemplazar ssl al leer estas opciones de la URL.
 for(const name of parsed.searchParams.keys())if(name.toLowerCase().startsWith('ssl')||name.toLowerCase()==='uselibpqcompat')throw new DatabaseStartupError('DATABASE_TLS_CONFLICT','Con DATABASE_SSL_CA, retira las opciones ssl de DATABASE_URL; TLS se configura mediante las variables DATABASE_SSL_*.');
 const ssl={ca:pem(ca),rejectUnauthorized:true,minVersion:'TLSv1.2' as const,...cert&&key?{cert:pem(cert),key:pem(key)}:{}};
 try{new X509Certificate(ssl.ca);createSecureContext(ssl);}catch{throw invalid();}
 return {...config,ssl};
}
