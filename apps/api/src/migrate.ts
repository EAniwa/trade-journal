import { privateMigration } from "./supabase";
import { readFile, readdir } from "node:fs/promises";
import { createPool } from "./database";
const url = process.env.JOURNAL_MIGRATION_URL;
if (!url) throw new Error("Set JOURNAL_MIGRATION_URL for the migration owner connection");
const pool = createPool(url);
try { const directory=new URL("../migrations/",import.meta.url); for(const name of (await readdir(directory)).filter(name=>name.endsWith(".sql")).sort()) { const sql=await readFile(new URL(name,directory),"utf8");await pool.query(process.env.JOURNAL_DATABASE_SCHEMA && process.env.JOURNAL_DATABASE_SCHEMA!=="public"?privateMigration(sql,process.env.JOURNAL_DATABASE_SCHEMA):sql); console.log(`Applied ${name}`); } }
finally { await pool.end(); }
