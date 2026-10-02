import { createHash,randomBytes,randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createPool, verifyRuntimeRole, withUser } from "../src/database";
import { googleUser,createTransfer,consumeTransfer } from "../src/google";
import { enqueue, workOne } from "../src/jobs";
import { ingest, decodeCursor, executionFingerprint } from "../src/store";
import { hashPassword, verifyPassword } from "../src/auth";

const enabled=Boolean(process.env.JOURNAL_TEST_DATABASE_URL&&process.env.JOURNAL_TEST_WORKER_URL&&process.env.JOURNAL_TEST_ADMIN_URL);
describe.skipIf(!enabled)("PostgreSQL hosted journal integration",()=> {
  const pool=createPool(process.env.JOURNAL_TEST_DATABASE_URL??"postgresql://localhost/unused");
  const worker=createPool(process.env.JOURNAL_TEST_WORKER_URL??"postgresql://localhost/unused");
  const admin=createPool(process.env.JOURNAL_TEST_ADMIN_URL??"postgresql://localhost/unused");
  const app=createApp(pool,{registration:true,demo:true,authLimit:10000});
  const userIds:string[]=[];
  const password="a-long-test-password-123";
  let alice:{id:string;token:string},bob:{id:string;token:string},aliceAccount:string,bobAccount:string;
  const fills=[{symbol:"AAPL",side:"buy",quantity:10,price:100,fee:1,executedAt:"2026-09-01T14:00:00Z"},{symbol:"AAPL",side:"sell",quantity:10,price:105,fee:1,executedAt:"2026-09-01T14:30:00Z"}];
  const headers=(who=alice)=>({authorization:`Bearer ${who.token}`});
  async function register() {
    const response=await app.inject({method:"POST",url:"/auth/register",payload:{email:`${randomUUID()}@test.invalid`,password}});
    expect(response.statusCode).toBe(201);
    const body=response.json();userIds.push(body.user.id);return {id:body.user.id,token:body.token};
  }
  async function createAccount(who=alice,currency="USD") {
    const response=await app.inject({method:"POST",url:"/accounts",headers:headers(who),payload:{name:"Integration account",currency,initialBalance:10000}});
    expect(response.statusCode).toBe(201);return response.json().id as string;
  }
  async function runJob(id:string,who=alice) {
    for(let i=0;i<30;i++) {
      const response=await app.inject({url:`/jobs/${id}`,headers:headers(who)}),job=response.json().job;
      if(["completed","failed","cancelled"].includes(job.status)) return job;
      await workOne(pool,worker);
    }
    throw new Error("Job did not finish");
  }
  beforeAll(async()=> {await app.ready();await verifyRuntimeRole(pool);alice=await register();bob=await register();aliceAccount=await createAccount();bobAccount=await createAccount(bob);},30000);
  afterAll(async()=> {await app.close();await admin.query("DELETE FROM journal_users WHERE id=ANY($1::uuid[])",[userIds]);await Promise.all([pool.end(),worker.end(),admin.end()]);});
  it("uses stable Google identities and refuses automatic email account takeover",async()=> {
    const identity={subject:randomUUID(),email:`${randomUUID()}@google.test.invalid`};
    const first=await googleUser(pool,identity);userIds.push(first.id);
    expect((await googleUser(pool,{...identity,email:"changed@google.test.invalid"})).id).toBe(first.id);
    const existing=(await admin.query("SELECT email FROM journal_users WHERE id=$1",[alice.id])).rows[0].email;
    await expect(googleUser(pool,{subject:randomUUID(),email:existing})).rejects.toThrow("already has an account");
  });
  it("binds native transfers to the device verifier and consumes them once",async()=> {
    const verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
    const ticket=await createTransfer(pool,alice.id,challenge);
    await expect(consumeTransfer(pool,ticket,"wrong-verifier")).rejects.toThrow();
    const results=await Promise.allSettled([consumeTransfer(pool,ticket,verifier),consumeTransfer(pool,ticket,verifier)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const expired=await createTransfer(pool,alice.id,challenge);
    await admin.query("UPDATE journal_auth_transfers SET expires_at=now()-interval '1 second'");
    await expect(consumeTransfer(pool,expired,verifier)).rejects.toThrow();
  });
  it("hashes passwords with independent salts and rejects wrong passwords",async()=> {
    const a=await hashPassword(password),b=await hashPassword(password);
    expect(a).not.toBe(b);expect(await verifyPassword(password,a)).toBe(true);expect(await verifyPassword("wrong",a)).toBe(false);
  });
  it("requires a valid unexpired session and supports logout revocation",async()=> {
    for(const authorization of [undefined,"Bearer forged-token"]) expect((await app.inject({url:"/accounts",headers:authorization?{authorization}:{}})).statusCode).toBe(401);
    const other=await register();
    expect((await app.inject({method:"DELETE",url:"/auth/session",headers:headers(other)})).statusCode).toBe(200);
    expect((await app.inject({url:"/accounts",headers:headers(other)})).statusCode).toBe(401);
    const expired=await register();await admin.query("UPDATE journal_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[expired.id]);
    expect((await app.inject({url:"/me",headers:headers(expired)})).statusCode).toBe(401);
  });
  it("rejects weak passwords, malformed input, and attempts to supply another owner",async()=> {
    expect((await app.inject({method:"POST",url:"/auth/register",payload:{email:"test@test.invalid",password:"short"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/accounts",headers:headers(),payload:{name:"test",user_id:bob.id}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/accounts",headers:headers(),payload:{name:"  "}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/executions",headers:headers(),payload:{accountId:aliceAccount,executions:[{...fills[0],quantity:-1}]}})).statusCode).toBe(400);
  });
  it("edits only owned accounts, refreshes balances, and protects imported currencies",async()=> {
    const id=await createAccount();
    const payload={name:"Updated broker account",currency:"CAD",initialBalance:2500,broker:"Test broker"};
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(bob),payload})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(),payload})).statusCode).toBe(200);
    const accounts=(await app.inject({url:"/accounts",headers:headers()})).json().accounts;
    expect(accounts.find((a:{id:string})=>a.id===id)).toMatchObject(payload);
    const response=await app.inject({method:"POST",url:"/executions",headers:headers(),payload:{accountId:id,executions:fills}});
    expect(response.statusCode).toBe(202);
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(),payload:{...payload,currency:"USD"}})).statusCode).toBe(409);
    expect(await runJob(response.json().job.id)).toMatchObject({status:"completed"});
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(),payload:{...payload,currency:"USD"}})).statusCode).toBe(409);
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(),payload:{...payload,name:"Renamed after import",initialBalance:3000}})).statusCode).toBe(200);
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(),payload:{...payload,name:" "}})).statusCode).toBe(400);
    expect((await app.inject({method:"PATCH",url:`/accounts/${id}`,headers:headers(),payload:{...payload,user_id:bob.id}})).statusCode).toBe(400);
    await admin.query("DELETE FROM journal_accounts WHERE user_id=$1 AND id=$2",[alice.id,id]);
    await withUser(pool,alice.id,async client=>{ const {refreshOverview}=await import("../src/store");await refreshOverview(client,alice.id); });
  });
  it("enforces user isolation on raw SQL, rejects forged ownership, and clears pooled context",async()=> {
    const unscoped=await pool.query("SELECT * FROM journal_accounts");expect(unscoped.rows).toHaveLength(0);
    await withUser(pool,alice.id,async client=> {
      const result=await client.query("SELECT user_id FROM journal_accounts");expect(result.rows.every(r=>r.user_id===alice.id)).toBe(true);
      expect((await client.query("SELECT * FROM journal_accounts WHERE id=$1",[bobAccount])).rows).toHaveLength(0);
    });
    await expect(withUser(pool,alice.id,client=>client.query("INSERT INTO journal_accounts(user_id,id,name,kind) VALUES($1,$2,'Forged','manual')",[bob.id,randomUUID()]))).rejects.toThrow();
    expect((await pool.query("SELECT * FROM journal_accounts")).rows).toHaveLength(0);
    const concurrent=await Promise.all(Array.from({length:25},(_,i)=>withUser(pool,i%2?alice.id:bob.id,async client=>(await client.query("SELECT user_id FROM journal_accounts")).rows.map(r=>r.user_id))));
    concurrent.forEach((ids,i)=>expect(ids.every(id=>id===(i%2?alice.id:bob.id))).toBe(true));
  });
  it("refuses privileged runtime database roles",async()=> {await expect(verifyRuntimeRole(admin)).rejects.toThrow("without SUPERUSER");});
  it("queues manual fills, preserves fees, produces metrics, and remains idempotent after completion",async()=> {
    const response=await app.inject({method:"POST",url:"/executions",headers:{...headers(),"idempotency-key":"manual-first-job"},payload:{accountId:aliceAccount,executions:fills}});
    expect(response.statusCode).toBe(202);const id=response.json().job.id;
    expect(await runJob(id)).toMatchObject({status:"completed",result:{inserted:2,duplicates:0}});
    const overview=(await app.inject({url:"/overview",headers:headers()})).json();expect(overview.metrics.netPnl).toBe(48);
    const repeat=await app.inject({method:"POST",url:"/executions",headers:{...headers(),"idempotency-key":"manual-first-job"},payload:{accountId:aliceAccount,executions:fills}});
    expect(repeat.statusCode).toBe(202);expect(repeat.json().job.id).toBe(id);
    const collision=await app.inject({method:"POST",url:"/executions",headers:{...headers(),"idempotency-key":"manual-first-job"},payload:{accountId:aliceAccount,executions:[{...fills[0],price:99}]}});
    expect(collision.statusCode).toBe(409);
    const duplicate=await enqueue(pool,alice.id,aliceAccount,"import",{executions:fills},"manual-repeat-another-key");
    expect(await runJob(duplicate.id)).toMatchObject({status:"completed",result:{inserted:0,duplicates:2}});
  });
  it("permanently deletes only an owned account after explicit confirmation and removes dependent data",async()=> {
    const id=await createAccount();const job=await enqueue(pool,alice.id,id,"import",{executions:fills});await runJob(job.id);
    await app.inject({method:"PUT",url:`/documents/journal/${id}:2026-09-01`,headers:headers(),payload:{version:0,payload:{notes:"Private account notes"}}});
    expect((await app.inject({method:"DELETE",url:`/accounts/${id}`,headers:headers(),payload:{}})).statusCode).toBe(400);
    expect((await app.inject({method:"DELETE",url:`/accounts/${id}`,headers:headers(bob),payload:{confirmation:"DELETE"}})).statusCode).toBe(404);
    expect((await app.inject({method:"DELETE",url:`/accounts/${id}`,headers:headers(),payload:{confirmation:"DELETE"}})).statusCode).toBe(200);
    expect((await app.inject({url:`/documents/journal/${id}:2026-09-01`,headers:headers()})).json().document).toBeNull();
    expect((await app.inject({method:"PUT",url:`/documents/journal/${id}:2026-09-01`,headers:headers(),payload:{version:0,payload:{notes:"Late save"}}})).statusCode).toBe(404);
    for(const table of ["journal_accounts","journal_executions","journal_trades","journal_jobs"]){const key=table==="journal_accounts"?"id":"account_id";expect((await admin.query(`SELECT count(*) FROM ${table} WHERE user_id=$1 AND ${key}=$2`,[alice.id,id])).rows[0].count).toBe("0");}
    expect((await app.inject({url:`/performance?accountId=${id}`,headers:headers()})).statusCode).toBe(404);
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}&period=all`,headers:headers()})).statusCode).toBe(200);
  });
  it("filters performance by the owned account and selected local date window",async()=> {
    const report=await app.inject({url:`/performance?accountId=${aliceAccount}&period=1d&asOf=2026-09-01`,headers:headers()});
    expect(report.statusCode).toBe(200);expect(report.json()).toMatchObject({currencies:["USD"],metrics:{closedTrades:1,netPnl:48},moneyMade:48,moneyLost:0,symbols:[{name:"AAPL",trades:1}]});
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}&period=1d&asOf=2026-09-02`,headers:headers()})).json().metrics.closedTrades).toBe(0);
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}`,headers:headers(bob)})).statusCode).toBe(404);
    expect((await app.inject({url:`/performance?accountId=${bobAccount}&period=all`,headers:headers(bob)})).json().metrics.closedTrades).toBe(0);
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}&asOf=2026-02-30`,headers:headers()})).statusCode).toBe(400);
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}&period=invalid`,headers:headers()})).statusCode).toBe(400);
    const trade=(await app.inject({url:`/trades?accountId=${aliceAccount}`,headers:headers()})).json().trades[0];
    const review=await app.inject({method:"PATCH",url:`/trades/${encodeURIComponent(trade.key)}`,headers:headers(),payload:{version:trade.version,sector:"Technology",stopLoss:95,profitTarget:110}});
    expect(review.statusCode).toBe(200);
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}&period=all`,headers:headers()})).json().sectors[0].name).toBe("Technology");
    const cleared=await app.inject({method:"PATCH",url:`/trades/${encodeURIComponent(trade.key)}`,headers:headers(),payload:{version:review.json().version,sector:"",stopLoss:null,profitTarget:null}});
    expect(cleared.statusCode).toBe(200);expect(cleared.json().annotations.stopLoss).toBeNull();
    expect((await app.inject({url:`/performance?accountId=${aliceAccount}&period=all`,headers:headers()})).json().sectors[0].name).toBe("Unclassified");

  });
  it("returns 404 for another user's accounts, jobs, and trade keys",async()=> {
    const denied=await app.inject({method:"POST",url:"/executions",headers:headers(bob),payload:{accountId:aliceAccount,executions:fills}});expect(denied.statusCode).toBe(404);
    const list=(await app.inject({url:"/trades",headers:headers()})).json();expect(list.trades.length).toBeGreaterThan(0);
    expect((await app.inject({url:`/trades/${encodeURIComponent(list.trades[0].key)}`,headers:headers(bob)})).statusCode).toBe(404);
    const job=await enqueue(pool,alice.id,aliceAccount,"import",{executions:fills},"owner-check-job");
    expect((await app.inject({url:`/jobs/${job.id}`,headers:headers(bob)})).statusCode).toBe(404);
    expect((await app.inject({method:"DELETE",url:`/jobs/${job.id}`,headers:headers(bob)})).statusCode).toBe(404);
    await runJob(job.id);
  });
  it("preserves trade annotations across rebuilds and rejects stale saves",async()=> {
    const trade=(await app.inject({url:"/trades",headers:headers()})).json().trades[0];
    const save=await app.inject({method:"PATCH",url:`/trades/${encodeURIComponent(trade.key)}`,headers:headers(),payload:{version:trade.version,notes:"Followed my plan",reviewed:true,rating:4}});expect(save.statusCode).toBe(200);
    expect((await app.inject({method:"PATCH",url:`/trades/${encodeURIComponent(trade.key)}`,headers:headers(),payload:{version:trade.version,notes:"Stale overwrite"}})).statusCode).toBe(409);
    const job=await enqueue(pool,alice.id,aliceAccount,"import",{executions:fills},"annotation-rebuild");await runJob(job.id);
    const refreshed=(await app.inject({url:`/trades/${encodeURIComponent(trade.key)}`,headers:headers()})).json();expect(refreshed.annotations).toMatchObject({notes:"Followed my plan",reviewed:true,rating:4});
  });
  it("stores the same journal date independently for different users and enforces optimistic concurrency",async()=> {
    for(const [who,notes] of [[alice,"Alice private journal"],[bob,"Bob private journal"]] as const) {
      const response=await app.inject({method:"PUT",url:"/documents/journal/2026-09-30",headers:headers(who),payload:{version:0,payload:{notes}}});expect(response.statusCode).toBe(200);
    }
    expect((await app.inject({url:"/documents/journal/2026-09-30",headers:headers()})).json().document.payload.notes).toBe("Alice private journal");
    expect((await app.inject({url:"/documents/journal/2026-09-30",headers:headers(bob)})).json().document.payload.notes).toBe("Bob private journal");
    expect((await app.inject({method:"PUT",url:"/documents/journal/2026-09-30",headers:headers(),payload:{version:0,payload:{notes:"overwrite"}}})).statusCode).toBe(409);
  });
  it("rolls back invalid batches without partial financial writes",async()=> {
    const count=await withUser(pool,alice.id,async client=>(await client.query("SELECT count(*) FROM journal_executions")).rows[0].count);
    await expect(withUser(pool,alice.id,client=>ingest(client,alice.id,aliceAccount,[...fills,{...fills[0],quantity:0}],"manual"))).rejects.toThrow();
    expect(await withUser(pool,alice.id,async client=>(await client.query("SELECT count(*) FROM journal_executions")).rows[0].count)).toBe(count);
  });
  it("uses durable exclusive worker claims and recovers a crashed worker's expired lease",async()=> {
    const one=await enqueue(pool,alice.id,aliceAccount,"import",{executions:fills},"crash-one");
    const two=await enqueue(pool,bob.id,bobAccount,"import",{executions:fills},"crash-two");
    const claims=await Promise.all([worker.query("SELECT * FROM journal_claim_job()"),worker.query("SELECT * FROM journal_claim_job()")]);
    expect(new Set(claims.map(c=>c.rows[0].id)).size).toBe(2);
    expect(new Set(claims.map(c=>c.rows[0].id))).toEqual(new Set([one.id,two.id]));
    await admin.query("UPDATE journal_jobs SET lease_until=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[[one.id,two.id]]);
    for(const claim of claims) expect((await worker.query("SELECT journal_renew_job($1,$2,$3) AS renewed",[claim.rows[0].user_id,claim.rows[0].id,claim.rows[0].lease_id])).rows[0].renewed).toBe(false);
    expect(await runJob(one.id)).toMatchObject({status:"completed",attempts:2});
    expect(await runJob(two.id,bob)).toMatchObject({status:"completed",attempts:2});
  });
  it("cancels queued work and records invalid statements as failed without retries",async()=> {
    const cancelled=await enqueue(pool,alice.id,aliceAccount,"import",{executions:fills},"cancel-queued");
    expect((await app.inject({method:"DELETE",url:`/jobs/${cancelled.id}`,headers:headers()})).statusCode).toBe(200);
    expect(await runJob(cancelled.id)).toMatchObject({status:"cancelled"});
    const invalid=await enqueue(pool,alice.id,aliceAccount,"import",{content:"this is not a broker statement"},"bad-statement");
    expect(await runJob(invalid.id)).toMatchObject({status:"failed",attempts:1});
  });
  it("paginates with a stable cursor and avoids duplicate rows",async()=> {
    const rows=[];for(let day=2;day<=8;day++){const date=`2026-09-${String(day).padStart(2,"0")}`;rows.push({...fills[0],executedAt:`${date}T14:00:00Z`},{...fills[1],executedAt:`${date}T14:30:00Z`});}
    const job=await enqueue(pool,alice.id,aliceAccount,"import",{executions:rows},"pagination");await runJob(job.id);
    let cursor:string|null=null;const keys:string[]=[];
    do {const result=await app.inject({url:`/trades?limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,headers:headers()});expect(result.statusCode).toBe(200);const body:{trades:{key:string}[];nextCursor:string|null}=result.json();keys.push(...body.trades.map((t:{key:string})=>t.key));cursor=body.nextCursor;}while(cursor);
    expect(new Set(keys).size).toBe(keys.length);expect(keys.length).toBe(8);
    expect((await app.inject({url:"/trades?cursor=invalid",headers:headers()})).statusCode).toBe(400);
    expect((await app.inject({url:"/trades?limit=1000",headers:headers()})).statusCode).toBe(400);
  });
  it("uses versioned timezone settings and avoids aggregating unlike currencies",async()=> {
    expect((await app.inject({method:"PUT",url:"/settings",headers:headers(),payload:{timeZone:"Invalid/Zone",version:0}})).statusCode).toBe(400);
    expect((await app.inject({method:"PUT",url:"/settings",headers:headers(),payload:{timeZone:"America/Toronto",version:99}})).statusCode).toBe(409);
    expect((await app.inject({method:"PUT",url:"/settings",headers:headers(),payload:{timeZone:"America/Toronto",version:0}})).statusCode).toBe(200);
    expect((await app.inject({url:"/overview",headers:headers()})).json().timeZone).toBe("America/Toronto");
    await createAccount(alice,"CAD");const overview=(await app.inject({url:"/overview",headers:headers()})).json();expect(overview.mixedCurrencies).toBe(true);expect(overview.metrics).toBeUndefined();
  });
  it("enforces auth throttling across instances and rejects streamed oversized bodies",async()=> {
    await admin.query("DELETE FROM journal_auth_limits");
    const limited=createApp(pool,{registration:true,authLimit:1});await limited.ready();
    const email=(await admin.query("SELECT email FROM journal_users WHERE id=$1",[bob.id])).rows[0].email;
    expect((await limited.inject({method:"POST",url:"/auth/login",payload:{email,password}})).statusCode).toBe(200);
    expect((await limited.inject({method:"POST",url:"/auth/login",payload:{email,password}})).statusCode).toBe(429);
    const oversized=await app.inject({method:"POST",url:"/imports",headers:{...headers(),"content-type":"application/json"},payload:JSON.stringify({accountId:aliceAccount,content:"x".repeat(21*1024*1024)})});expect(oversized.statusCode).toBe(413);
    await limited.close();await admin.query("DELETE FROM journal_auth_limits");
  });
  it("provides independent demo workspaces and hides diagnostic details",async()=> {
    const a=(await app.inject({method:"POST",url:"/auth/demo",payload:{}})).json(),b=(await app.inject({method:"POST",url:"/auth/demo",payload:{}})).json();
    userIds.push(a.user.id,b.user.id);expect(a.user.id).not.toBe(b.user.id);
    const response=await app.inject({url:"/accounts",headers:{authorization:`Bearer ${a.token}`}});expect(response.statusCode).toBe(200);expect(response.headers["server-timing"]).toMatch(/^app;dur=/);expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("hosted storage validation",()=> {
  it("rejects malformed cursors",()=> {for(const value of ["invalid",Buffer.from('[null,42]').toString("base64url"),"a".repeat(3000)])expect(()=>decodeCursor(value)).toThrow("Invalid cursor");});
  it("normalizes fill symbol casing and equivalent timestamps for deduplication",()=> {
    const a={symbol:"aapl",side:"buy" as const,quantity:10,price:100,fee:1,executedAt:"2026-09-01T14:00:00Z"};
    expect(executionFingerprint(a)).toBe(executionFingerprint({...a,symbol:"AAPL",executedAt:"2026-09-01T10:00:00-04:00"}));
  });
});
