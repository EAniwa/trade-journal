import { createPool, verifyRuntimeRole } from "./database";
import { createApp } from "./app";
if(!process.env.JOURNAL_DATABASE_URL) throw new Error("Set JOURNAL_DATABASE_URL");
const pool=createPool(process.env.JOURNAL_DATABASE_URL); await verifyRuntimeRole(pool);
const app=createApp(pool,{registration:process.env.JOURNAL_ALLOW_REGISTRATION==="1",demo:process.env.JOURNAL_DEMO==="1",supabaseUrl:process.env.SUPABASE_URL,log:true});
app.addHook("onClose",async()=>pool.end());
process.once("SIGINT",()=>void app.close()); process.once("SIGTERM",()=>void app.close());
await app.listen({port:Number(process.env.PORT??4000),host:process.env.HOST??"127.0.0.1"});
