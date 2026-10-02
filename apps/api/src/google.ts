import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Database } from './database';
import { assert, ApiError } from './errors';
import { hashToken, newSession } from './auth';
export type GoogleConfig={clientId:string;clientSecret:string;redirectUri:string};
const keys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:5000});
export function googleConfig():GoogleConfig|undefined {
  const clientId=process.env.GOOGLE_CLIENT_ID,clientSecret=process.env.GOOGLE_CLIENT_SECRET,redirectUri=process.env.GOOGLE_REDIRECT_URI;
  if(!clientId||!clientSecret||!redirectUri)return undefined;
  const url=new URL(redirectUri);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Google redirect must use HTTPS or loopback');
  return {clientId,clientSecret,redirectUri};
}
export function googleIdentity(payload:JWTPayload,nonce:string) {
  assert(typeof payload.exp==='number'&&payload.nonce===nonce&&typeof payload.sub==='string'&&payload.sub.length>0,'Invalid Google session',401);
  assert(payload.email_verified===true&&typeof payload.email==='string'&&payload.email.length<=254,'Google email must be verified',401);
  return {subject:payload.sub,email:payload.email.toLowerCase()};
}
export async function exchangeGoogle(config:GoogleConfig,code:string,verifier:string,nonce:string) {
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirectUri}),signal:AbortSignal.timeout(10000)});
  assert(response.ok,'Google sign-in could not be completed. Please retry.',401);
  const result=await response.json() as {id_token?:string};assert(result.id_token,'Google sign-in could not be completed',401);
  try {
    const {payload}=await jwtVerify(result.id_token,keys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:config.clientId,algorithms:['RS256']});
    return googleIdentity(payload,nonce);
  }catch{throw new ApiError(401,'Invalid Google session');}
}
export async function googleUser(pool:Database,identity:{subject:string;email:string}) {
  // Stable Google subject is the identity. Existing email accounts require explicit linking.
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['google:'+identity.subject]);
    const found=await client.query<{id:string;email:string}>('SELECT u.id,u.email FROM journal_identities i JOIN journal_users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2',['google',identity.subject]);
    if(found.rows[0]){await client.query('COMMIT');return found.rows[0];}
    const inserted=await client.query<{id:string;email:string}>('INSERT INTO journal_users(id,email) VALUES(gen_random_uuid(),$1) ON CONFLICT(email) DO NOTHING RETURNING id,email',[identity.email]);
    assert(inserted.rows[0],'This email already has an account. Sign in with your password; Google account linking is not enabled yet.',409);
    const user=inserted.rows[0];await client.query('INSERT INTO journal_identities(provider,subject,user_id) VALUES($1,$2,$3)',['google',identity.subject,user.id]);
    await client.query('COMMIT');return user;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function createTransfer(pool:Database,userId:string,challenge:string) {
  const ticket=randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO journal_auth_transfers(ticket_hash,user_id,challenge,expires_at) VALUES($1,$2,$3,now()+interval '60 seconds')",[hashToken(ticket),userId,challenge]);return ticket;
}
export async function consumeTransfer(pool:Database,ticket:string,verifier:string) {
  const {createHash}=await import('node:crypto');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const result=await pool.query<{user_id:string}>('DELETE FROM journal_auth_transfers WHERE ticket_hash=$1 AND challenge=$2 AND expires_at>now() RETURNING user_id',[hashToken(ticket),challenge]);
  assert(result.rows[0],'Sign-in expired. Please try again.',401);return newSession(pool,result.rows[0].user_id);
}
