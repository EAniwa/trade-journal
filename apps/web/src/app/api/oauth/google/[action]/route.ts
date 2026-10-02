import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
export const dynamic='force-dynamic';
const FLOW='journal_google_flow',SESSION='journal_hosted_session';
const service=()=>process.env.JOURNAL_SERVICE_URL??'http://127.0.0.1:4000';
const headers={'Content-Type':'application/json'};
const options=(request:Request)=>({httpOnly:true,secure:new URL(request.url).protocol==='https:',sameSite:'lax' as const,path:'/api/oauth/google',maxAge:600});
const sessionOptions=(request:Request,expiresAt:string)=>({httpOnly:true,secure:new URL(request.url).protocol==='https:',sameSite:'strict' as const,path:'/',maxAge:Math.max(0,Math.floor((Date.parse(expiresAt)-Date.now())/1000))});
type Flow={state:string;nonce:string;verifier:string;nativeChallenge?:string;created:number};
type Context={params:Promise<{action:string}>};
function safeEqual(a:string,b:string){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
function failed(request:Request,message='google-failed'){return NextResponse.redirect(new URL('/workspace?authError='+message,request.url),303);}
export async function GET(request:Request,context:Context) {
  const {action}=await context.params,url=new URL(request.url),jar=await cookies();
  if(action==='start') {
    try {
      const response=await fetch(service()+'/auth/providers',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      const provider=(await response.json()).google as {enabled:boolean;clientId?:string;redirectUri?:string};
      if(!provider.enabled||!provider.clientId||!provider.redirectUri)return failed(request,'google-unavailable');
      if(new URL(provider.redirectUri).origin!==url.origin)return failed(request,'google-unavailable');
      const nativeChallenge=url.searchParams.get('nativeChallenge')??undefined;
      if(nativeChallenge&&!/^[A-Za-z0-9_-]{43}$/.test(nativeChallenge))return failed(request);
      const flow:Flow={state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),nativeChallenge,created:Date.now()};
      jar.set(FLOW,JSON.stringify(flow),options(request));
      const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search=new URLSearchParams({client_id:provider.clientId,redirect_uri:provider.redirectUri,response_type:'code',scope:'openid email profile',state:flow.state,nonce:flow.nonce,code_challenge:createHash('sha256').update(flow.verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'}).toString();
      return NextResponse.redirect(auth,{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }catch{return failed(request,'google-unavailable');}
  }
  if(action==='callback') {
    const stored=jar.get(FLOW)?.value;jar.set(FLOW,"",{...options(request),maxAge:0});
    try {
      if(!stored)return failed(request);const flow=JSON.parse(stored) as Flow;
      if(!flow.state||!flow.verifier||!flow.nonce||!Number.isFinite(flow.created)||Date.now()-flow.created>600000||Date.now()<flow.created||!safeEqual(flow.state,url.searchParams.get('state')??'')||!url.searchParams.get('code'))return failed(request);
      const response=await fetch(service()+'/auth/google',{method:'POST',headers,body:JSON.stringify({code:url.searchParams.get('code'),verifier:flow.verifier,nonce:flow.nonce,...(flow.nativeChallenge?{nativeChallenge:flow.nativeChallenge}:{})}),signal:AbortSignal.timeout(15000)});
      const result=await response.json();if(!response.ok)return failed(request,result.error?.includes('already has an account')?'google-link-required':'google-failed');
      if(flow.nativeChallenge&&result.ticket)return NextResponse.redirect('tradejournal://auth?ticket='+encodeURIComponent(result.ticket),{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
      if(!result.token||!result.expiresAt)return failed(request);
      jar.set(SESSION,result.token,sessionOptions(request,result.expiresAt));return NextResponse.redirect(new URL('/workspace',request.url),{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }catch{return failed(request);}
  }
  return NextResponse.json({error:'Not found'},{status:404});
}
export async function POST(request:Request,context:Context) {
  const {action}=await context.params;if(action!=='native')return NextResponse.json({error:'Not found'},{status:404});
  const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return NextResponse.json({error:'Invalid origin'},{status:403});
  try {
    const payload=await request.json();
    const response=await fetch(service()+'/auth/google/transfer',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok)return failed(request);
    const jar=await cookies();jar.set(SESSION,result.token,sessionOptions(request,result.expiresAt));return NextResponse.redirect(new URL('/workspace',request.url),303);
  }catch{return failed(request);}
}
