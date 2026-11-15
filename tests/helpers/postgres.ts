/** Clúster PostgreSQL real y aislado; no usa DATABASE_URL ni bases existentes. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,appendFile,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {createServer} from 'node:net';
const exec=promisify(execFile);
export async function temporaryPostgres(options:{tlsIp?:string}={}){
 const dir=await mkdtemp(join(tmpdir(),'light-link-pg-')),data=join(dir,'data');
 const bin=(name:string)=>process.env.TEST_POSTGRES_BIN_DIR?join(process.env.TEST_POSTGRES_BIN_DIR,name):name;
 let running=false;
 async function start(){await exec(bin('pg_ctl'),['-D',data,'-l',join(dir,'postgres.log'),'-w','start']);running=true;}
 async function stop(){if(running){await exec(bin('pg_ctl'),['-D',data,'-m','fast','-w','stop']);running=false;}}
 let tlsPort=0;
 if(options.tlsIp){const probe=createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});tlsPort=(probe.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>probe.close(e=>e?reject(e):resolve()));}
 const port=tlsPort||55432;
 const adminUrl=`postgresql://light_link_test@localhost/postgres?host=${encodeURIComponent(dir)}&port=${port}`;
 try{
  await exec(bin('initdb'),['-D',data,'--username=light_link_test','--auth=trust','--no-locale','--encoding=UTF8']);
  await appendFile(join(data,'postgresql.conf'),`\nlisten_addresses = ''\nunix_socket_directories = '${dir}'\nport = 55432\n`);
  if(options.tlsIp){
   await exec('bash',['deployment/prepare-postgres-tls.sh',options.tlsIp,join(dir,'tls')]);
   await appendFile(join(data,'postgresql.conf'),`\nlisten_addresses = '127.0.0.1'\nport = ${port}\nssl = on\nssl_cert_file = '${dir}/tls/server/server.crt'\nssl_key_file = '${dir}/tls/server/server.key'\nssl_ca_file = '${dir}/tls/ca.crt'\n`);
   await writeFile(join(data,'pg_hba.conf'),"local all all trust\nhostssl all light_link_app 127.0.0.1/32 cert\nhost all all 127.0.0.1/32 reject\n");
  }
  await start();
  const pool=new Pool({connectionString:adminUrl});try{
   await pool.query(await readFile('migrations/001_accounts_missions.sql','utf8'));
   await pool.query(`CREATE ROLE light_link_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    REVOKE ALL ON DATABASE postgres FROM PUBLIC; GRANT CONNECT ON DATABASE postgres TO light_link_app;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO light_link_app;
    GRANT SELECT ON schema_migrations TO light_link_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON users,sessions,user_sites,missions,mission_members,mission_sites,auth_rate_limits TO light_link_app;`);
  }finally{await pool.end();}
  const url=adminUrl.replace('light_link_test@','light_link_app@');
  return {url,adminUrl,tlsUrl:`postgresql://light_link_app@127.0.0.1:${port}/postgres`,tlsDirectory:join(dir,'tls'),async restart(){await stop();await start();},async close(){await stop();await rm(dir,{recursive:true,force:true});}};
 }catch(error){await stop();await rm(dir,{recursive:true,force:true});throw error;}
}
