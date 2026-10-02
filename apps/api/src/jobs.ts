import { createHash, randomUUID } from "node:crypto";
import { parseAuto } from "@luxalgo/journal-importers";
import type { Database } from "./database";
import { withUser } from "./database";
import { ApiError, assert } from "./errors";
import { accountFor, ingest } from "./store";
function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if(value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function enqueue(pool:Database,userId:string,accountId:string,kind:"import"|"sync",payload:unknown,requestKey?:string) {
  const digest=createHash("sha256").update(canonical([accountId,kind,payload])).digest("hex");
  const key=requestKey??digest;
  assert(key.length>=8 && key.length<=200,"Invalid idempotency key");
  return withUser(pool,userId,async client=> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${userId}:${accountId}`]);
    await accountFor(client,userId,accountId);
    const result=await client.query<{id:string;status:string;payload_hash:string;kind:string;account_id:string}>(`INSERT INTO journal_jobs(user_id,id,account_id,kind,idempotency_key,payload,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING id,status,payload_hash,kind,account_id`,[userId,randomUUID(),accountId,kind,key,payload,digest]);
    const row=result.rows[0]!;
    assert(row.payload_hash===digest,"Idempotency key was used for a different request",409);
    return {id:row.id,status:row.status};
  });
}
export async function workOne(pool:Database,workerPool:Database):Promise<boolean> {
  const claim=await workerPool.query<{user_id:string;id:string;account_id:string;kind:string;payload:Record<string,unknown>;lease_id:string;attempts:number}>("SELECT * FROM journal_claim_job()");
  const job=claim.rows[0]; if(!job) return false;
  let leaseLost=false;
  const heartbeat=setInterval(()=> {
    void workerPool.query("SELECT journal_renew_job($1,$2,$3) AS renewed",[job.user_id,job.id,job.lease_id])
      .then(result=> { if(result.rows[0]?.renewed!==true) leaseLost=true; }).catch(()=>{leaseLost=true;});
  },15000);
  heartbeat.unref();
  try {
    let rows:unknown[], source:"manual"|"import"|"sync";
    if(job.kind === "import") {
      if(Array.isArray(job.payload.executions)) { rows=job.payload.executions; source="manual"; }
      else {
        assert(typeof job.payload.content === "string","Import content is missing");
        const parsed=parseAuto(job.payload.content,{timeZone:String(job.payload.timeZone??"UTC"),fileName:String(job.payload.fileName??"statement.csv")});
        assert(parsed,"This CSV column layout is not supported yet. Please use a supported broker export.");
        assert(!parsed.errors?.length,parsed.errors?.join(" ")??"Statement contains invalid rows");
        rows=parsed.executions; source="import";
      }
    } else {
      throw new ApiError(400,"Broker sync is not enabled for this account yet");
    }
    await withUser(pool,job.user_id,async client=> {
      const current=await client.query("SELECT id FROM journal_jobs WHERE user_id=$1 AND id=$2 AND lease_id=$3 AND status='running' AND lease_until>clock_timestamp()",[job.user_id,job.id,job.lease_id]);
      assert(current.rowCount===1 && !leaseLost,"Job lease expired",409);
      const result=await ingest(client,job.user_id,job.account_id,rows,source);
      assert(!leaseLost,"Job lease expired",409);
      const updated=await client.query("UPDATE journal_jobs SET status='completed',result=$4,payload='{}',lease_until=NULL,updated_at=now() WHERE user_id=$1 AND id=$2 AND lease_id=$3 AND lease_until>clock_timestamp()",[job.user_id,job.id,job.lease_id,result]);
      assert(updated.rowCount===1,"Job lease expired",409);
    });
  } catch(error) {
    // A lost worker cannot overwrite the replacement worker's state.
    const terminal=error instanceof ApiError && error.status!==409 || job.attempts>=3;
    await withUser(pool,job.user_id,client=>client.query(`UPDATE journal_jobs SET status=$4,error=$5,
      available_at=now()+($6::int * interval '1 second'),lease_until=NULL,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND lease_id=$3 AND status='running'`,[job.user_id,job.id,job.lease_id,terminal?"failed":"queued",error instanceof ApiError ? error.message : "Temporary processing failure",Math.min(60,2**job.attempts)]));
  } finally { clearInterval(heartbeat); }
  return true;
}
