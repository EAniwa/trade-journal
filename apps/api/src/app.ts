import {PERIODS,performanceWindow,accountPerformance,type Period} from "./performance";
import Fastify from "fastify";
import { googleConfig, exchangeGoogle, googleUser, createTransfer, consumeTransfer } from "./google";
import { createHash, randomUUID } from "node:crypto";
import { computeOverview, computeEdgeScore } from "@luxalgo/journal-core";
import { createAuthenticator, hashPassword, verifyPassword, newSession, hashToken } from "./auth";
import { withUser, type Database } from "./database";
import { assert, ApiError } from "./errors";
import { enqueue } from "./jobs";
import { decodeCursor, encodeCursor, readDocument, refreshOverview, accountFor } from "./store";
const uuid={type:"string",format:"uuid"};
const object=(properties:Record<string,unknown>,required:string[]=[])=>({type:"object",properties,required,additionalProperties:false});
const shortText={type:"string",minLength:1,maxLength:100};
const execution=object({symbol:shortText,side:{enum:["buy","sell"]},quantity:{type:"number",exclusiveMinimum:0},price:{type:"number"},fee:{type:"number"},executedAt:{type:"string",format:"date-time"},assetClass:{enum:["equity","option","futures","forex","crypto","cfd","other"]}},["symbol","side","quantity","price","executedAt"]);
export interface AppOptions { registration?:boolean; demo?:boolean; supabaseUrl?:string; log?:boolean; authLimit?:number; }
export function createApp(pool:Database, options:AppOptions={}) {
  const app=Fastify({logger:options.log ? {redact:["req.headers.authorization","req.headers.cookie","res.headers.set-cookie"]} : false,
    bodyLimit:20*1024*1024,requestTimeout:30000,connectionTimeout:10000,ajv:{customOptions:{removeAdditional:false}}});
  const authenticate=createAuthenticator(pool,options.supabaseUrl);
  const user=(req:{headers:{authorization?:string}})=>authenticate(req.headers.authorization?.replace(/^Bearer /,""));
  app.addHook("onRequest",async(req,reply)=> {
    reply.header("Cache-Control","private, no-store").header("X-Request-Id",req.id);
    if(pool.waitingCount>100) { reply.header("Retry-After","1"); throw new ApiError(503,"The server is busy. Try again shortly."); }
    const origin=req.headers.origin;
    if(origin && !["GET","HEAD","OPTIONS"].includes(req.method)) {
      // Browser writes go through the same-origin Next proxy. Native clients omit Origin.
      const allowed=process.env.JOURNAL_WEB_ORIGIN;
      assert(allowed && origin===allowed,"Cross-origin request rejected",403);
    }
  });
  app.addHook("onSend",async(req,reply,payload)=> { reply.header("Server-Timing",`app;dur=${reply.elapsedTime.toFixed(2)}`); return payload; });
  app.setErrorHandler((error,request,reply)=> {
    const code=error instanceof ApiError ? error.status : (error as {statusCode?:number}).statusCode??500;
    if(code>=500) request.log.error({event:"api_error",requestId:request.id,code},"Request failed");
    reply.code(code).send({error:error instanceof ApiError ? error.message : code<500 ? "Invalid request" : "Internal server error",requestId:request.id});
  });
  async function limitAuth(ip:string) {
    const hash=createHash("sha256").update(ip).digest("hex");
    const result=await pool.query<{attempts:number}>(`INSERT INTO journal_auth_limits(key,attempts,window_start) VALUES($1,1,now())
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN journal_auth_limits.window_start<now()-interval '1 minute' THEN 1 ELSE journal_auth_limits.attempts+1 END,
      window_start=CASE WHEN journal_auth_limits.window_start<now()-interval '1 minute' THEN now() ELSE journal_auth_limits.window_start END RETURNING attempts`,[hash]);
    assert(result.rows[0]!.attempts <= (options.authLimit??20),"Too many sign-in attempts. Try again in a minute.",429);
  }
  app.get("/health",async()=>({status:"ok",service:"journal-api"}));
  app.get("/ready",async()=> { await pool.query("SELECT 1"); return {status:"ready"}; });
  const authBody=object({email:{type:"string",minLength:3,maxLength:254,pattern:"^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"},password:{type:"string",minLength:1,maxLength:1024}},["email","password"]);
  app.post<{Body:{email:string;password:string}}>("/auth/register",{schema:{body:authBody}},async(req,reply)=> {
    assert(options.registration && !options.supabaseUrl,"Registration is not enabled",403);
    await limitAuth(req.ip); assert(req.body.password.length>=12,"Use a password with at least 12 characters");
    const id=randomUUID(), email=req.body.email.trim().toLowerCase(), hash=await hashPassword(req.body.password);
    const result=await pool.query("INSERT INTO journal_users(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id",[id,email,hash]);
    assert(result.rowCount===1,"Unable to create this account",409);
    reply.code(201); return {...await newSession(pool,id),user:{id,email}};
  });
  app.post<{Body:{email:string;password:string}}>("/auth/login",{schema:{body:authBody}},async(req)=> {
    assert(!options.supabaseUrl,"Use Supabase sign-in for this deployment",400);
    await limitAuth(req.ip);
    const result=await pool.query<{id:string;email:string;password_hash:string|null}>("SELECT id,email,password_hash FROM journal_users WHERE email=$1",[req.body.email.trim().toLowerCase()]);
    const row=result.rows[0];
    // Perform a derivation for unknown users too, so lookup timing doesn't reveal registration.
    const fallback="00000000000000000000000000000000:"+"00".repeat(64);
    const valid=await verifyPassword(req.body.password,row?.password_hash??fallback);
    assert(row && valid,"Email or password is incorrect",401);
    return {...await newSession(pool,row.id),user:{id:row.id,email:row.email}};
  });
  app.delete("/auth/session",async(req)=> {
    await user(req);
    await pool.query("DELETE FROM journal_sessions WHERE token_hash=$1",[hashToken(req.headers.authorization!.replace(/^Bearer /,""))]);
    return {signedOut:true};
  });
  app.get("/auth/providers",async()=> {const config=googleConfig();return {google:config&&!options.supabaseUrl?{enabled:true,clientId:config.clientId,redirectUri:config.redirectUri}:{enabled:false}};});
  app.post<{Body:{code:string;verifier:string;nonce:string;nativeChallenge?:string}}>("/auth/google",{schema:{body:object({code:{type:"string",minLength:1,maxLength:4096},verifier:{type:"string",pattern:"^[A-Za-z0-9_-]{43,128}$"},nonce:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"},nativeChallenge:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"}},["code","verifier","nonce"])}},async(req)=> {
    await limitAuth(req.ip);const config=googleConfig();assert(config&&!options.supabaseUrl,"Google sign-in is not available yet",503);
    const identity=await exchangeGoogle(config,req.body.code,req.body.verifier,req.body.nonce),account=await googleUser(pool,identity);
    if(req.body.nativeChallenge)return {ticket:await createTransfer(pool,account.id,req.body.nativeChallenge)};
    return {...await newSession(pool,account.id),user:account};
  });
  app.post<{Body:{ticket:string;verifier:string}}>("/auth/google/transfer",{schema:{body:object({ticket:{type:"string",pattern:"^[A-Za-z0-9_-]{43}$"},verifier:{type:"string",pattern:"^[A-Za-z0-9_-]{43,128}$"}},["ticket","verifier"])}},async(req)=> {await limitAuth(req.ip);return consumeTransfer(pool,req.body.ticket,req.body.verifier);});
  app.get("/me",async(req)=> { const id=await user(req); const result=await pool.query("SELECT id,email FROM journal_users WHERE id=$1",[id]); return {user:result.rows[0]}; });
  app.get("/accounts",async(req)=>withUser(pool,await user(req),async client=> {
    const result=await client.query("SELECT id,name,currency,kind,broker,initial_balance AS \"initialBalance\",method,created_at AS \"createdAt\" FROM journal_accounts WHERE archived_at IS NULL ORDER BY created_at,id");
    return {accounts:result.rows.map(row=>({...row,initialBalance:Number(row.initialBalance)}))};
  }));
  app.post<{Body:{name:string;broker?:string;currency?:string;kind?:string;initialBalance?:number;method?:string}}>("/accounts",{schema:{body:object({name:shortText,broker:{type:"string",maxLength:100},currency:{type:"string",pattern:"^[A-Z]{3}$"},kind:{enum:["manual","import"]},initialBalance:{type:"number"},method:{enum:["fifo","lifo","wavg"]}},["name"])}},async(req,reply)=> {
    assert(req.body.name.trim().length>0,"Enter an account name");
    const owner=await user(req), id=randomUUID();
    await withUser(pool,owner,async client=> {
      await client.query("INSERT INTO journal_accounts(user_id,id,name,currency,kind,initial_balance,method,broker) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[owner,id,req.body.name.trim(),req.body.currency??"USD",req.body.kind??"manual",req.body.initialBalance??0,req.body.method??"fifo",req.body.broker?.trim()||""]);
      await refreshOverview(client,owner);
    }); reply.code(201); return {id};
  });
  app.patch<{Params:{id:string};Body:{name:string;currency:string;initialBalance:number;broker?:string}}>("/accounts/:id",{schema:{params:object({id:uuid},["id"]),body:object({name:shortText,currency:{type:"string",pattern:"^[A-Z]{3}$"},initialBalance:{type:"number"},broker:{type:"string",maxLength:100}},["name","currency","initialBalance"])}},async(req)=> {
    assert(req.body.name.trim().length>0,"Enter an account name");
    const owner=await user(req);
    return withUser(pool,owner,async client=> {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${req.params.id}`]);
      const existing=await client.query<{currency:string}>("SELECT currency FROM journal_accounts WHERE user_id=$1 AND id=$2 AND archived_at IS NULL",[owner,req.params.id]);
      assert(existing.rows[0],"Account not found",404);
      if(existing.rows[0].currency!==req.body.currency) {
        const history=await client.query("SELECT 1 FROM journal_executions WHERE user_id=$1 AND account_id=$2 LIMIT 1",[owner,req.params.id]);
        const pending=await client.query("SELECT 1 FROM journal_jobs WHERE user_id=$1 AND account_id=$2 AND status IN ('queued','running') LIMIT 1",[owner,req.params.id]);
        assert(!history.rowCount&&!pending.rowCount,"Currency cannot change after trades or pending imports. Create a separate account for another currency.",409);
      }
      await client.query("UPDATE journal_accounts SET name=$3,currency=$4,initial_balance=$5,broker=$6 WHERE user_id=$1 AND id=$2",[owner,req.params.id,req.body.name.trim(),req.body.currency,req.body.initialBalance,req.body.broker?.trim()||""]);
      await refreshOverview(client,owner);
      return {id:req.params.id};
    });
  });
  app.delete<{Params:{id:string};Body:{confirmation:string}}>("/accounts/:id",{schema:{params:object({id:uuid},["id"]),body:object({confirmation:{const:"DELETE"}},["confirmation"])}},async(req)=> {
    const owner=await user(req);
    return withUser(pool,owner,async client=> {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${req.params.id}`]);
      await accountFor(client,owner,req.params.id);
      await client.query("DELETE FROM journal_documents WHERE user_id=$1 AND kind='journal' AND left(id,length($2)+1)=$2||':'",[owner,req.params.id]);
      await client.query("DELETE FROM journal_accounts WHERE user_id=$1 AND id=$2",[owner,req.params.id]);
      await refreshOverview(client,owner);
      return {deleted:true,id:req.params.id};
    });
  });
  app.get<{Querystring:{accountId:string;period?:Period;asOf?:string}}>("/performance",{schema:{querystring:object({accountId:uuid,period:{enum:PERIODS},asOf:{type:"string",pattern:"^\\d{4}-\\d{2}-\\d{2}$"}},["accountId"])}},async(req)=> {
    const owner=await user(req);
    return withUser(pool,owner,async client=> {
      const account=await accountFor(client,owner,req.query.accountId);
      const preferences=await readDocument(client,owner,"settings","preferences"),timeZone=String(preferences?.payload.timeZone??"UTC");
      const window=performanceWindow(req.query.period??"1m",timeZone,req.query.asOf);
      const rows=await client.query<{payload:import("@luxalgo/journal-core").AnnotatedTrade;annotations:Record<string,unknown>}>("SELECT payload,annotations FROM journal_trades WHERE user_id=$1 AND account_id=$2 AND ($3::date IS NULL OR (COALESCE(closed_at,opened_at) AT TIME ZONE $5)::date >= $3::date) AND (COALESCE(closed_at,opened_at) AT TIME ZONE $5)::date <= $4::date ORDER BY opened_at,key",[owner,account.id,window.from,window.to,timeZone]);
      return accountPerformance(rows.rows.map(row=>({...row.payload,annotations:row.annotations})),account.currency,Number(account.initial_balance),timeZone,window);
    });
  });
  app.get("/overview",async(req)=> { const id=await user(req); return withUser(pool,id,async client=> {
    const doc=await readDocument(client,id,"settings","overview");
    if(doc) return {...doc.payload,version:doc.version};
    const overview=computeOverview([],{timeZone:"UTC"}); return {...overview,timeZone:"UTC",currencies:[],edgeScore:computeEdgeScore(overview.metrics)};
  }); });
  app.get<{Querystring:{limit?:number;cursor?:string;accountId?:string}}>("/trades",{schema:{querystring:object({limit:{type:"integer",minimum:1,maximum:100},cursor:{type:"string",maxLength:2048},accountId:uuid})}},async(req)=> {
    const owner=await user(req),cursor=decodeCursor(req.query.cursor),limit=req.query.limit??30;
    return withUser(pool,owner,async client=> {
      const result=await client.query(`SELECT key,payload,annotations,version,opened_at FROM journal_trades WHERE user_id=$1
        AND ($2::uuid IS NULL OR account_id=$2) AND ($3::timestamptz IS NULL OR (opened_at,key)<($3::timestamptz,$4::text))
        ORDER BY opened_at DESC,key DESC LIMIT $5`,[owner,req.query.accountId??null,cursor?.[0]??null,cursor?.[1]??null,limit+1]);
      const rows=result.rows.slice(0,limit);
      return {trades:rows.map(row=>({...row.payload,annotations:row.annotations,version:row.version})),nextCursor:result.rows.length>limit ? encodeCursor(rows[rows.length-1]!) : null};
    });
  });
  const tradeParams=object({key:{type:"string",minLength:1,maxLength:1000}},["key"]);
  app.get<{Params:{key:string}}>("/trades/:key",{schema:{params:tradeParams}},async(req)=> {
    const owner=await user(req); return withUser(pool,owner,async client=> {
      const result=await client.query("SELECT payload,annotations,version FROM journal_trades WHERE user_id=$1 AND key=$2",[owner,req.params.key]);
      assert(result.rows[0],"Trade not found",404); return {...result.rows[0].payload,annotations:result.rows[0].annotations,version:result.rows[0].version};
    });
  });
  app.patch<{Params:{key:string};Body:{version:number;notes?:string;sector?:string;tags?:string[];rating?:number;reviewed?:boolean;stopLoss?:number|null;profitTarget?:number|null}}>("/trades/:key",{schema:{params:tradeParams,body:object({version:{type:"integer",minimum:1},notes:{type:"string",maxLength:100000},sector:{type:"string",maxLength:80},tags:{type:"array",maxItems:20,items:shortText},rating:{type:"integer",minimum:1,maximum:5},reviewed:{type:"boolean"},stopLoss:{type:["number","null"]},profitTarget:{type:["number","null"]}},["version"])}},async(req)=> {
    const owner=await user(req),{version,...changes}=req.body; return withUser(pool,owner,async client=> {
      const result=await client.query(`UPDATE journal_trades SET annotations=annotations || $4::jsonb,version=version+1 WHERE user_id=$1 AND key=$2 AND version=$3 RETURNING payload,annotations,version`,[owner,req.params.key,version,JSON.stringify(changes)]);
      if(!result.rows[0]) {
        const existing=await client.query("SELECT 1 FROM journal_trades WHERE user_id=$1 AND key=$2",[owner,req.params.key]);
        throw new ApiError(existing.rowCount?409:404,existing.rowCount?"This trade changed. Reload before saving.":"Trade not found");
      }
      return {...result.rows[0].payload,annotations:result.rows[0].annotations,version:result.rows[0].version};
    });
  });
  app.post<{Body:{accountId:string;executions:unknown[]}}>("/executions",{schema:{body:object({accountId:uuid,executions:{type:"array",minItems:1,maxItems:200,items:execution}},["accountId","executions"])}},async(req,reply)=> {
    const owner=await user(req),job=await enqueue(pool,owner,req.body.accountId,"import",{executions:req.body.executions},req.headers["idempotency-key"] as string|undefined);
    reply.code(202); return {job};
  });
  app.post<{Body:{accountId:string;content:string;fileName?:string;timeZone?:string}}>("/imports",{schema:{body:object({accountId:uuid,content:{type:"string",minLength:1,maxLength:19000000},fileName:{type:"string",maxLength:200},timeZone:{type:"string",maxLength:100}},["accountId","content"])}},async(req,reply)=> {
    if(req.body.timeZone) { try { new Intl.DateTimeFormat("en",{timeZone:req.body.timeZone}); } catch { throw new ApiError(400,"Invalid import timezone"); } }
    const job=await enqueue(pool,await user(req),req.body.accountId,"import",req.body,req.headers["idempotency-key"] as string|undefined);
    reply.code(202); return {job};
  });
  const jobParams=object({id:uuid},["id"]);
  app.get<{Params:{id:string}}>("/jobs/:id",{schema:{params:jobParams}},async(req)=> {
    const owner=await user(req); return withUser(pool,owner,async client=> {
      const result=await client.query("SELECT id,account_id AS \"accountId\",kind,status,attempts,result,error,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM journal_jobs WHERE user_id=$1 AND id=$2",[owner,req.params.id]);
      assert(result.rows[0],"Job not found",404); return {job:result.rows[0]};
    });
  });
  app.delete<{Params:{id:string}}>("/jobs/:id",{schema:{params:jobParams}},async(req)=> {
    const owner=await user(req); return withUser(pool,owner,async client=> {
      const result=await client.query("UPDATE journal_jobs SET status='cancelled',payload='{}',updated_at=now() WHERE user_id=$1 AND id=$2 AND status='queued' RETURNING id",[owner,req.params.id]);
      if(!result.rowCount) {
        const exists=await client.query("SELECT status FROM journal_jobs WHERE user_id=$1 AND id=$2",[owner,req.params.id]);
        assert(exists.rowCount,"Job not found",404); throw new ApiError(409,"Only queued imports can be cancelled");
      } return {cancelled:true};
    });
  });
  const docParams=object({kind:{enum:["journal","note","playbook","progress","missed","prop"]},id:{type:"string",minLength:1,maxLength:200}},["kind","id"]);
  app.get<{Params:{kind:string;id:string}}>("/documents/:kind/:id",{schema:{params:docParams}},async(req)=> {
    const owner=await user(req); return withUser(pool,owner,async client=>({document:await readDocument(client,owner,req.params.kind,req.params.id)}));
  });
  app.put<{Params:{kind:string;id:string};Body:{version:number;payload:Record<string,unknown>}}>("/documents/:kind/:id",{schema:{params:docParams,body:object({version:{type:"integer",minimum:0},payload:{type:"object",maxProperties:100}},["version","payload"])}},async(req)=> {
    const owner=await user(req); assert(Buffer.byteLength(JSON.stringify(req.body.payload))<=200000,"Document is too large",413);
    return withUser(pool,owner,async client=> {
      const {kind,id}=req.params;
      if(kind==="journal"&&/^[0-9a-f-]{36}:/i.test(id)){const accountId=id.slice(0,36);await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${accountId}`]);await accountFor(client,owner,accountId);}
      const result=req.body.version===0 ? await client.query(`INSERT INTO journal_documents(user_id,kind,id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING payload,version`,[owner,kind,id,req.body.payload]) : await client.query(`UPDATE journal_documents SET payload=$4,version=version+1,updated_at=now() WHERE user_id=$1 AND kind=$2 AND id=$3 AND version=$5 RETURNING payload,version`,[owner,kind,id,req.body.payload,req.body.version]);
      assert(result.rows[0],"This document changed. Reload before saving.",409); return {document:result.rows[0]};
    });
  });
  app.get("/settings",async(req)=> {
    const owner=await user(req); return withUser(pool,owner,async client=>({settings:await readDocument(client,owner,"settings","preferences")}));
  });
  app.put<{Body:{timeZone:string;version:number}}>("/settings",{schema:{body:object({timeZone:{type:"string",maxLength:100},version:{type:"integer",minimum:0}},["timeZone","version"])}},async(req)=> {
    try { new Intl.DateTimeFormat("en",{timeZone:req.body.timeZone}); } catch { throw new ApiError(400,"Invalid timezone"); }
    const owner=await user(req); return withUser(pool,owner,async client=> {
      const result=req.body.version===0 ? await client.query(`INSERT INTO journal_documents(user_id,kind,id,payload) VALUES($1,'settings','preferences',$2) ON CONFLICT DO NOTHING RETURNING payload,version`,[owner,{timeZone:req.body.timeZone}]) : await client.query(`UPDATE journal_documents SET payload=$2,version=version+1,updated_at=now() WHERE user_id=$1 AND kind='settings' AND id='preferences' AND version=$3 RETURNING payload,version`,[owner,{timeZone:req.body.timeZone},req.body.version]);
      assert(result.rows[0],"Settings changed. Reload before saving.",409);
      await refreshOverview(client,owner); return {settings:result.rows[0]};
    });
  });
  app.post("/auth/demo",async(req)=> {
    assert(options.demo && process.env.NODE_ENV!=="production","Demo sessions are disabled",404); await limitAuth(req.ip);
    const owner=randomUUID(), accountId=randomUUID(), email=`demo+${owner}@localhost.test`;
    await pool.query("INSERT INTO journal_users(id,email) VALUES($1,$2)",[owner,email]);
    await withUser(pool,owner,client=>client.query("INSERT INTO journal_accounts(user_id,id,name,kind,initial_balance) VALUES($1,$2,'Demo portfolio','manual',25000)",[owner,accountId]));
    const executions=[];
    for(let day=1;day<=30;day++) {
      const time=new Date(Date.now()-day*86400000); time.setUTCHours(14,0,0,0);
      const symbol=["AAPL","NVDA","SPY"][day%3]!; const price=[225,130,555][day%3]!;
      executions.push({symbol,side:"buy",quantity:50,price,fee:1,executedAt:time.toISOString()});
      executions.push({symbol,side:"sell",quantity:50,price:price+(day%3===0?-1.5:2.4),fee:1,executedAt:new Date(time.getTime()+1800000).toISOString()});
    }
    const job=await enqueue(pool,owner,accountId,"import",{executions});
    return {...await newSession(pool,owner),user:{id:owner,email},job};
  });
  return app;
}
