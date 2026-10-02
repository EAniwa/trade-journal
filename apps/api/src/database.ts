import { databaseOptions,type DatabaseEnvironment } from "./database-options";
import pg, { type PoolClient } from "pg";
const { Pool } = pg;
export type Client = PoolClient;
const schemas=new WeakMap<pg.Pool,string>();
export function createPool(url: string, env:DatabaseEnvironment=process.env) {
  if(env.JOURNAL_DATABASE_SSL === "1" && /[?&]ssl(?:mode|rootcert|cert|key)=/i.test(url))throw new Error("Configure verified TLS through JOURNAL_DATABASE_SSL rather than URL SSL parameters");
  const pool=new Pool({ connectionString:url, ...databaseOptions(env), idleTimeoutMillis:30000,
    connectionTimeoutMillis:5000, statement_timeout:10000, application_name:"tradeform-api" });
  schemas.set(pool,env.JOURNAL_DATABASE_SCHEMA??"public");return pool;
}
export type Database = ReturnType<typeof createPool>;
/** Both tenant identity and role live only for this transaction. Never SET globally on a pooled connection. */
export async function withUser<T>(pool: Database, userId: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('journal.user_id',$1,true)",[userId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function verifyRuntimeRole(pool: Database): Promise<void> {
  const result = await pool.query<{unsafe:boolean;schema:string}>("SELECT rolsuper OR rolbypassrls AS unsafe,current_schema() AS schema FROM pg_roles WHERE rolname=current_user");
  if(result.rows[0]?.schema !== schemas.get(pool))throw new Error("The runtime connection is not using its configured database schema");
  if (result.rows[0]?.unsafe !== false) throw new Error("The API requires a PostgreSQL role without SUPERUSER or BYPASSRLS");
}
