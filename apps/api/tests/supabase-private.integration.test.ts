import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createPool,verifyRuntimeRole,withUser } from '../src/database';
import { createApp } from '../src/app';
import { privateMigration } from '../src/supabase';
import { workOne } from '../src/jobs';
const enabled=Boolean(process.env.JOURNAL_TEST_DATABASE_URL&&process.env.JOURNAL_TEST_WORKER_URL&&process.env.JOURNAL_TEST_ADMIN_URL);
describe.skipIf(!enabled)('private-schema migration against PostgreSQL',()=> {
 const schema='tradeform_test_'+randomUUID().replaceAll('-','');
 const admin=createPool(process.env.JOURNAL_TEST_ADMIN_URL??'postgresql://localhost/unused');
 const pool=createPool(process.env.JOURNAL_TEST_DATABASE_URL??'postgresql://localhost/unused',{JOURNAL_DATABASE_SCHEMA:schema});
 const worker=createPool(process.env.JOURNAL_TEST_WORKER_URL??'postgresql://localhost/unused',{JOURNAL_DATABASE_SCHEMA:schema});
 const app=createApp(pool,{registration:true,authLimit:10000});let token:string,userId:string,accountId:string;
 beforeAll(async()=> {
  const client=await admin.connect();
  try {
   await client.query('BEGIN');await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET LOCAL search_path=${schema},pg_temp`);
   const directory=new URL('../migrations/',import.meta.url);
   for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await client.query(privateMigration(await readFile(new URL(name,directory),'utf8'),schema));
   await client.query(`GRANT USAGE ON SCHEMA ${schema} TO journal_api,journal_worker`);
   await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO journal_api`);
   await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.journal_claim_job(),${schema}.journal_renew_job(uuid,uuid,uuid) TO journal_worker`);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await app.ready();const registration=await app.inject({method:'POST',url:'/auth/register',payload:{email:'private@test.invalid',password:'a-long-private-password'}});expect(registration.statusCode).toBe(201);token=registration.json().token;userId=registration.json().user.id;
 },30000);
 afterAll(async()=> {await app.close();await Promise.all([pool.end(),worker.end()]);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('opens restricted runtime roles in the configured private schema',async()=>{await verifyRuntimeRole(pool);await verifyRuntimeRole(worker);expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);});
 it('keeps private user accounts invisible without a transaction owner',async()=>{const response=await app.inject({method:'POST',url:'/accounts',headers:{authorization:`Bearer ${token}`},payload:{name:'Private schema account',currency:'USD'}});expect(response.statusCode).toBe(201);accountId=response.json().id;expect((await pool.query('SELECT * FROM journal_accounts')).rows).toHaveLength(0);expect((await withUser(pool,userId,c=>c.query('SELECT * FROM journal_accounts'))).rows).toHaveLength(1);});
 it('runs queue functions against private tables and rebuilds performance',async()=>{const response=await app.inject({method:'POST',url:'/executions',headers:{authorization:`Bearer ${token}`},payload:{accountId,executions:[{symbol:'AAPL',side:'buy',quantity:1,price:100,executedAt:'2026-09-01T12:00:00Z'},{symbol:'AAPL',side:'sell',quantity:1,price:110,executedAt:'2026-09-01T13:00:00Z'}]}});expect(response.statusCode).toBe(202);expect(await workOne(pool,worker)).toBe(true);const job=await app.inject({url:`/jobs/${response.json().job.id}`,headers:{authorization:`Bearer ${token}`}});expect(job.json().job.status).toBe('completed');const overview=await app.inject({url:'/overview',headers:{authorization:`Bearer ${token}`}});expect(overview.json().metrics.netPnl).toBe(10);});
});
