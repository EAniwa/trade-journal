import { createHash, randomUUID } from "node:crypto";
import { buildRoundTrips, computeOverview, computeEdgeScore, type Execution, type AnnotatedTrade, type ProfitCalcMethod } from "@luxalgo/journal-core";
import type { Client } from "./database";
import { assert } from "./errors";
export interface Account { id:string; name:string; currency:string; kind:string; broker:string; initial_balance:string; method:ProfitCalcMethod; credentials_enc:string|null; }
export function validateExecution(row:unknown):asserts row is Omit<Execution,"id"|"accountId"|"source"> {
  assert(row && typeof row === "object","Execution must be an object");
  const e=row as Record<string,unknown>;
  assert(typeof e.symbol === "string" && e.symbol.trim().length>0 && e.symbol.length<=100,"Enter a valid symbol");
  assert(e.side === "buy" || e.side === "sell","Side must be buy or sell");
  assert(typeof e.quantity === "number" && Number.isFinite(e.quantity) && e.quantity>0,"Quantity must be positive");
  assert(typeof e.price === "number" && Number.isFinite(e.price),"Price must be finite");
  assert(e.fee === undefined || typeof e.fee === "number" && Number.isFinite(e.fee),"Fee must be finite");
  assert(typeof e.executedAt === "string" && Number.isFinite(Date.parse(e.executedAt)),"Enter a valid execution time");
  assert(e.assetClass === undefined || ["equity","option","futures","forex","crypto","cfd","other"].includes(e.assetClass as string),"Invalid asset class");
  // Only the trusted statement importer may attach source-specific metadata.
}
export function executionFingerprint(e:Omit<Execution,"id"|"accountId"|"source">):string {
  return createHash("sha256").update(JSON.stringify([e.symbol.trim().toUpperCase(),e.side,e.quantity,e.price,new Date(e.executedAt).toISOString(),e.importMetadata?.group??"",e.importMetadata?.id??""])).digest("hex");
}
export async function accountFor(client:Client,userId:string,id:string):Promise<Account> {
  const result=await client.query<Account>("SELECT * FROM journal_accounts WHERE user_id=$1 AND id=$2 AND archived_at IS NULL",[userId,id]);
  assert(result.rows[0],"Account not found",404); return result.rows[0];
}
export async function ingest(client:Client,userId:string,accountId:string,rows:unknown[],source:Execution["source"]) {
  assert(rows.length>0 && rows.length<=100000,"Import must contain 1 to 100,000 executions");
  for(const row of rows) validateExecution(row);
  // Serializes rebuilds even when multiple API/worker replicas process an account.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${userId}:${accountId}`]);
  const account=await accountFor(client,userId,accountId);
  let inserted=0;
  for(let start=0;start<rows.length;start+=500) {
    const batch=rows.slice(start,start+500).map(raw=> {
      const e=raw as Omit<Execution,"id"|"accountId"|"source">;
      const payload={...e,symbol:e.symbol.trim().toUpperCase(),fee:e.fee??0,executedAt:new Date(e.executedAt).toISOString(),id:randomUUID(),accountId,source};
      return {id:payload.id,hash:executionFingerprint(e),time:payload.executedAt,payload};
    });
    const result=await client.query(`INSERT INTO journal_executions(user_id,id,account_id,content_hash,executed_at,payload)
      SELECT $1,x.id,$2,x.hash,x.time,x.payload FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,hash text,time timestamptz,payload jsonb)
      ON CONFLICT(user_id,account_id,content_hash) DO NOTHING`,[userId,accountId,JSON.stringify(batch)]);
    inserted+=result.rowCount??0;
  }
  const executions=await client.query<{payload:Execution}>("SELECT payload FROM journal_executions WHERE user_id=$1 AND account_id=$2 ORDER BY executed_at,id",[userId,accountId]);
  const settings=await readDocument(client,userId,"settings","preferences");
  const multipliers=(settings?.payload.multipliers??{}) as Record<string,number>;
  const trips=buildRoundTrips(executions.rows.map(row=>row.payload),{method:account.method,multipliers});
  const keep=trips.map(trip=>trip.key);
  for(let start=0;start<trips.length;start+=500) {
    const batch=trips.slice(start,start+500).map(trip=>({key:trip.key,opened:trip.openedAt,closed:trip.closedAt??null,payload:trip}));
    await client.query(`INSERT INTO journal_trades(user_id,key,account_id,opened_at,closed_at,payload)
      SELECT $1,x.key,$2,x.opened,x.closed,x.payload FROM jsonb_to_recordset($3::jsonb) AS x(key text,opened timestamptz,closed timestamptz,payload jsonb)
      ON CONFLICT(user_id,key) DO UPDATE SET payload=EXCLUDED.payload,opened_at=EXCLUDED.opened_at,closed_at=EXCLUDED.closed_at,version=journal_trades.version+1`,[userId,accountId,JSON.stringify(batch)]);
  }
  await client.query("DELETE FROM journal_trades WHERE user_id=$1 AND account_id=$2 AND NOT(key=ANY($3::text[]))",[userId,accountId,keep]);
  await refreshOverview(client,userId);
  return {inserted,duplicates:rows.length-inserted,trades:trips.length};
}
export async function refreshOverview(client:Client,userId:string) {
  // Serializes per-user snapshot updates; dashboard requests never rebuild long histories.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${userId}:overview`]);
  const tradeRows=await client.query<{payload:AnnotatedTrade;annotations:Record<string,unknown>}>("SELECT payload,annotations FROM journal_trades WHERE user_id=$1 ORDER BY opened_at,key",[userId]);
  const accountRows=await client.query<{initial_balance:string;currency:string}>("SELECT initial_balance,currency FROM journal_accounts WHERE user_id=$1 AND archived_at IS NULL",[userId]);
  const preferences=await readDocument(client,userId,"settings","preferences");
  const timeZone=String(preferences?.payload.timeZone??"UTC");
  const initialBalance=accountRows.rows.reduce((sum,a)=>sum+Number(a.initial_balance),0);
  const currencies=[...new Set(accountRows.rows.map(a=>a.currency))];
  // Never sum unlike currencies into a misleading financial figure.
  if(currencies.length>1) {
    await upsertInternal(client,userId,"overview",{mixedCurrencies:true,currencies,timeZone}); return;
  }
  const trades=tradeRows.rows.map(row=>({...row.payload,annotations:row.annotations})) as AnnotatedTrade[];
  const overview=computeOverview(trades,{timeZone,initialBalance});
  await upsertInternal(client,userId,"overview",{...overview,days:overview.days.slice(-365),equity:overview.equity.slice(-1000),edgeScore:computeEdgeScore(overview.metrics),currencies,timeZone,initialBalance,updatedAt:new Date().toISOString()});
}
async function upsertInternal(client:Client,userId:string,id:string,payload:unknown) {
  await client.query(`INSERT INTO journal_documents(user_id,kind,id,payload) VALUES($1,'settings',$2,$3)
    ON CONFLICT(user_id,kind,id) DO UPDATE SET payload=EXCLUDED.payload,version=journal_documents.version+1,updated_at=now()`,[userId,id,payload]);
}
export async function readDocument(client:Client,userId:string,kind:string,id:string) {
  const result=await client.query<{payload:Record<string,unknown>;version:number}>("SELECT payload,version FROM journal_documents WHERE user_id=$1 AND kind=$2 AND id=$3",[userId,kind,id]);
  return result.rows[0]??null;
}
export function encodeCursor(row:{opened_at:Date|string;key:string}) { return Buffer.from(JSON.stringify([new Date(row.opened_at).toISOString(),row.key])).toString("base64url"); }
export function decodeCursor(value:string|undefined):[string,string]|null {
  if(!value) return null;
  try {
    assert(value.length<2048,"Invalid cursor");
    const parsed=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    assert(Array.isArray(parsed)&&parsed.length===2&&typeof parsed[0]==="string"&&Number.isFinite(Date.parse(parsed[0]))&&typeof parsed[1]==="string"&&parsed[1].length<1000,"Invalid cursor");
    return parsed as [string,string];
  } catch { assert(false,"Invalid cursor"); }
}
