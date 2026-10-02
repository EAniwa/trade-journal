import { setTimeout } from "node:timers/promises";
import { createPool, verifyRuntimeRole } from "./database";
import { workOne } from "./jobs";
if(!process.env.JOURNAL_DATABASE_URL || !process.env.JOURNAL_WORKER_URL) throw new Error("Configure database and worker connections");
const pool=createPool(process.env.JOURNAL_DATABASE_URL), worker=createPool(process.env.JOURNAL_WORKER_URL);
await verifyRuntimeRole(pool);await verifyRuntimeRole(worker);
let stopping=false;
process.once("SIGINT",()=>{stopping=true;}); process.once("SIGTERM",()=>{stopping=true;});
try { while(!stopping) { try { if(!await workOne(pool,worker)) await setTimeout(500); } catch { console.error(JSON.stringify({event:"worker_retry",time:new Date().toISOString()})); await setTimeout(1000); } } }
finally { await pool.end(); await worker.end(); }
