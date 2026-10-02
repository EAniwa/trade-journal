import { readFileSync } from 'node:fs';
export type DatabaseEnvironment=Record<string,string|undefined>;
export function databaseOptions(env:DatabaseEnvironment=process.env) {
  const schema=env.JOURNAL_DATABASE_SCHEMA??'public';
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid database schema');
  const max=Number(env.JOURNAL_DATABASE_POOL_MAX??12);
  if(!Number.isInteger(max)||max<1||max>50)throw new Error('Database pool size must be between 1 and 50');
  const ssl=env.JOURNAL_DATABASE_SSL==='1'?{rejectUnauthorized:true,...(env.JOURNAL_DATABASE_CA_FILE?{ca:readFileSync(env.JOURNAL_DATABASE_CA_FILE,'utf8')}:{})}:undefined;
  return {max,options:`-c search_path=${schema},pg_temp`,...(ssl?{ssl}:{})};
}
