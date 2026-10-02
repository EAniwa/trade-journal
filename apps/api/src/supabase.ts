import { readFile,writeFile,chmod,readdir,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes,createHash } from 'node:crypto';
import { createPool,verifyRuntimeRole,type Database } from './database';
export type SupabaseConnection={projectUrl:string;adminUrl:string;caFile?:string};
export const tables=['journal_users','journal_identities','journal_accounts','journal_executions','journal_trades','journal_documents','journal_jobs','journal_sessions'] as const;
export function connectionDetails(config:SupabaseConnection) {
  const project=new URL(config.projectUrl),db=new URL(config.adminUrl);
  if(project.protocol!=='https:'||!/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname)||project.username||project.password||project.search||project.hash||project.pathname!=='/')throw new Error('Use the Supabase project HTTPS URL');
  const ref=project.hostname.split('.')[0]!;
  if(!['postgres:','postgresql:'].includes(db.protocol)||db.pathname!=='/postgres'||db.port&&db.port!=='5432')throw new Error('Use the direct or session-pooler PostgreSQL connection on port 5432');
  const direct=db.hostname===`db.${ref}.supabase.co`,pooled=/\.pooler\.supabase\.com$/.test(db.hostname);
  const username=decodeURIComponent(db.username);
  if(!(direct&&username==='postgres'||pooled&&username===`postgres.${ref}`)||!db.password)throw new Error('The database connection must match this Supabase project and include its database password');
  for(const name of ['sslmode','sslrootcert','sslcert','sslkey'])db.searchParams.delete(name);
  if(db.searchParams.toString())throw new Error('Unexpected connection parameters');
  return {ref,url:db.toString(),suffix:pooled?`.${ref}`:''};
}
export function privateMigration(sql:string,schema='tradeform') {
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid private schema');
  return sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'').replace(/SET search_path = public, pg_temp/g,`SET search_path = ${schema}, pg_temp`);
}
export function runtimeUrl(adminUrl:string,role:string,password:string,suffix:string) {
  const url=new URL(adminUrl);url.username=role+suffix;url.password=password;return url.toString();
}
export function canonical(value:unknown):string {
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value);
}
export function fingerprint(rows:unknown[]) {return createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex');}
async function loadPrivate(path:string) {
  if((await stat(path)).mode&0o077)throw new Error('Credential configuration must have mode 0600');
  try{return JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('Invalid private configuration JSON');}
}
export async function runMigration(mode:string,configPath:string,runtimePath:string,sourcePath:string) {
  if(!['plan','provision','copy','verify'].includes(mode))throw new Error('Choose plan, provision, copy, or verify');
  const config=await loadPrivate(configPath) as SupabaseConnection,details=connectionDetails(config);
  const env={JOURNAL_DATABASE_SCHEMA:'tradeform',JOURNAL_DATABASE_POOL_MAX:'2',JOURNAL_DATABASE_SSL:'1',...(config.caFile?{JOURNAL_DATABASE_CA_FILE:config.caFile}:{})};
  const target=createPool(details.url,env);
  let source:Database|undefined;
  try {
    const access=await target.query<{owner:string;bypass:boolean}>("SELECT current_user AS owner,rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user");
    if(access.rows[0]?.bypass!==true)throw new Error('The migration owner needs RLS bypass for private queue functions; do not use a runtime role');
    const exists=await target.query("SELECT 1 FROM pg_namespace WHERE nspname='tradeform'");
    if(mode==='plan') {
      console.log(JSON.stringify({project:config.projectUrl,connection:details.suffix?'session pooler':'direct',schema:'tradeform',schemaExists:Boolean(exists.rowCount),tlsVerified:true,auth:'existing Tradeform login retained'},null,2));return;
    }
    if(mode==='provision') {
      if(exists.rowCount)throw new Error('The tradeform schema already exists; inspect it before provisioning. No existing schema will be overwritten');
      const roles=await target.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1)",[['tradeform_api','tradeform_worker']]);
      if(roles.rowCount)throw new Error('Tradeform runtime roles already exist; inspect them before provisioning');
      const apiPassword=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex');
      const client=await target.connect();
      try {
        await client.query('BEGIN');await client.query('CREATE SCHEMA tradeform');await client.query('SET LOCAL search_path=tradeform,pg_temp');
        await client.query(`CREATE ROLE tradeform_api LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${apiPassword}'`);
        await client.query(`CREATE ROLE tradeform_worker LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${workerPassword}'`);
        const directory=new URL('../migrations/',import.meta.url);
        for(const name of (await readdir(directory)).filter(x=>x.endsWith('.sql')).sort())await client.query(privateMigration(await readFile(new URL(name,directory),'utf8')));
        await client.query('REVOKE ALL ON SCHEMA tradeform FROM PUBLIC,anon,authenticated,service_role');
        await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA tradeform FROM PUBLIC,anon,authenticated,service_role');
        await client.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tradeform FROM PUBLIC,anon,authenticated,service_role');
        await client.query('ALTER ROLE tradeform_api SET search_path=tradeform,pg_temp');await client.query('ALTER ROLE tradeform_worker SET search_path=tradeform,pg_temp');
        await client.query('GRANT USAGE ON SCHEMA tradeform TO tradeform_api,tradeform_worker');
        await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA tradeform TO tradeform_api');
        await client.query('GRANT EXECUTE ON FUNCTION tradeform.journal_claim_job(),tradeform.journal_renew_job(uuid,uuid,uuid) TO tradeform_worker');
        // Persist recoverable credentials before committing the roles. Never print them.
        await writeFile(runtimePath,JSON.stringify({api:runtimeUrl(details.url,'tradeform_api',apiPassword,details.suffix),worker:runtimeUrl(details.url,'tradeform_worker',workerPassword,details.suffix),schema:'tradeform',ssl:true,poolMax:4,caFile:config.caFile??null,projectUrl:config.projectUrl}),{mode:0o600,flag:'wx'});await chmod(runtimePath,0o600);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      console.log('Private schema and restricted runtime roles created. Runtime credentials saved to the private configuration file.');return;
    }
    if(!exists.rowCount)throw new Error('Provision the private schema first');
    if(mode==='verify') {
      const runtime=await loadPrivate(runtimePath),api=createPool(runtime.api,env),worker=createPool(runtime.worker,env);
      try {
        await verifyRuntimeRole(api);await verifyRuntimeRole(worker);
        const policies=await target.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='tradeform' AND relname=ANY($1)",[['journal_accounts','journal_executions','journal_trades','journal_documents','journal_jobs']]);
        if(policies.rows.length!==5||policies.rows.some(x=>!x.relrowsecurity||!x.relforcerowsecurity))throw new Error('Owner isolation policies are incomplete');
        const exposed=await target.query("SELECT rol,has_schema_privilege(rol,'tradeform','USAGE') AS access FROM unnest(ARRAY['anon','authenticated','service_role']) rol");
        if(exposed.rows.some(x=>x.access))throw new Error('Private schema is accessible to a Data API role');
        const canClaim=await worker.query("SELECT has_function_privilege(current_user,'tradeform.journal_claim_job()','EXECUTE') AS allowed");
        if(!canClaim.rows[0]?.allowed)throw new Error('Worker queue permissions are missing');
        if((await api.query('SELECT * FROM journal_accounts')).rowCount!==0)throw new Error('Unscoped runtime query exposed account data');
        console.log('TLS, private schema, runtime roles, owner isolation and worker permissions verified.');
      }finally{await Promise.all([api.end(),worker.end()]);}return;
    }
    // Quiesce the local application first. Keep its database unchanged for rollback.
    let active=false;try{const response=await fetch('http://127.0.0.1:4000/health',{signal:AbortSignal.timeout(1000)});active=response.ok;}catch{}
    if(active)throw new Error('Stop the local app/API/worker stack before copying data');
    const local=await loadPrivate(sourcePath);source=createPool(local.admin,{JOURNAL_DATABASE_SCHEMA:'public',JOURNAL_DATABASE_POOL_MAX:'1'});
    const from=await source.connect(),to=await target.connect();
    try {
      await from.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await to.query('BEGIN');
      await to.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['tradeform-initial-copy']);
      for(const table of tables)if(Number((await to.query(`SELECT count(*) AS count FROM tradeform.${table}`)).rows[0].count)!==0)throw new Error('The Supabase target contains data; initial copy will not overwrite it');
      const users=(await from.query("SELECT id FROM public.journal_users WHERE email NOT LIKE 'demo+%@localhost.test'")).rows.map(row=>row.id);
      if((await from.query("SELECT 1 FROM public.journal_jobs WHERE user_id=ANY($1::uuid[]) AND status='running' AND lease_until>now() LIMIT 1",[users])).rowCount)throw new Error('Wait for running imports to finish or their worker leases to expire before copying');
      const report:Record<string,{rows:number;verified:boolean}>={};
      for(const table of tables) {
        const ownerColumn=table==='journal_users'?'id':'user_id';
        const rows=(await from.query(`SELECT * FROM public.${table} WHERE ${ownerColumn}=ANY($1::uuid[])${table==='journal_sessions'?' AND expires_at>now()':''}`,[users])).rows;
        if(table==='journal_jobs')for(const row of rows)if(row.status==='running'){row.status=row.attempts>=3?'failed':'queued';row.lease_id=null;row.lease_until=null;}
        for(let i=0;i<rows.length;i+=500)await to.query(`INSERT INTO tradeform.${table} SELECT * FROM jsonb_populate_recordset(NULL::tradeform.${table},$1::jsonb)`,[JSON.stringify(rows.slice(i,i+500))]);
        const copied=(await to.query(`SELECT * FROM tradeform.${table}`)).rows;
        if(fingerprint(rows)!==fingerprint(copied))throw new Error('Copied rows failed integrity verification; target transaction rolled back');
        report[table]={rows:rows.length,verified:true};
      }
      await to.query('COMMIT');await from.query('COMMIT');console.log(JSON.stringify({copied:report,excluded:'Generated demo workspaces, expired sessions, temporary OAuth handoffs and old rate-limit counters',localDatabase:'preserved'},null,2));
    }catch(error){await Promise.allSettled([from.query('ROLLBACK'),to.query('ROLLBACK')]);throw error;}finally{from.release();to.release();}
  }finally{await Promise.all([target.end(),source?.end()]);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,config,runtime,source]=process.argv.slice(2);
  if(!mode||!config||!runtime||!source)throw new Error('Usage: supabase.ts plan|provision|copy|verify <private connection file> <private runtime file> <private local config>');
  runMigration(mode,resolve(config),resolve(runtime),resolve(source)).catch(error=>{console.error(error instanceof Error?error.message:'Migration failed');process.exitCode=1;});
}
