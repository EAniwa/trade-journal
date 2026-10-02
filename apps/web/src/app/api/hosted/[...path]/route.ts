import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isSameOrigin } from "../../../../server/request-policy";
export const dynamic="force-dynamic";
const COOKIE="journal_hosted_session";
type Context={params:Promise<{path:string[]}>};
async function proxy(request:Request,context:Context) {
  const {path}=await context.params;
  if(!path.length || path.some(part=>part.length>1200 || part.includes("/") || part==="..")) return NextResponse.json({error:"Invalid endpoint"},{status:400});
  if(!["GET","HEAD"].includes(request.method) && !isSameOrigin(request))
    return NextResponse.json({error:"Cross-origin request rejected"},{status:403});
  const jar=await cookies(), token=jar.get(COOKIE)?.value;
  const headers=new Headers();
  if(request.headers.get("content-type")) headers.set("content-type",request.headers.get("content-type")!);
  if(request.headers.get("idempotency-key")) headers.set("idempotency-key",request.headers.get("idempotency-key")!);
  if(token) headers.set("authorization",`Bearer ${token}`);
  const base=process.env.JOURNAL_SERVICE_URL??"http://127.0.0.1:4000";
  const upstream=new URL(path.map(encodeURIComponent).join("/"),base.replace(/\/$/,"")+"/");
  upstream.search=new URL(request.url).search;
  try {
    const response=await fetch(upstream,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,duplex:"half",cache:"no-store",signal:AbortSignal.timeout(15000)} as RequestInit);
    const body=await response.json();
    if(response.ok && path[0]==="auth" && body.token) {
      jar.set(COOKIE,body.token,{httpOnly:true,sameSite:"strict",secure:new URL(request.url).protocol==="https:",path:"/",maxAge:Math.max(0,Math.floor((Date.parse(body.expiresAt)-Date.now())/1000))});
      delete body.token;
    }
    if(path.join("/")==="auth/session" && request.method==="DELETE" && response.ok) jar.delete(COOKIE);
    const result=NextResponse.json(body,{status:response.status,headers:{"Cache-Control":"private, no-store"}});
    for(const name of ["Server-Timing","X-Request-Id","Retry-After"]) if(response.headers.has(name)) result.headers.set(name,response.headers.get(name)!);
    return result;
  } catch { return NextResponse.json({error:"The journal service is unavailable. Please retry."},{status:503,headers:{"Cache-Control":"private, no-store"}}); }
}
export const GET=proxy, POST=proxy, PUT=proxy, PATCH=proxy, DELETE=proxy;
