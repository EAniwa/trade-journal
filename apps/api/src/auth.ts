import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Database } from "./database";
import { ApiError, assert } from "./errors";
const derive = promisify(scrypt);
export const hashToken = (token:string) => createHash("sha256").update(token).digest("hex");
export async function hashPassword(password:string):Promise<string> {
  const salt=randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password,salt,64) as Buffer).toString("hex")}`;
}
export async function verifyPassword(password:string, stored:string):Promise<boolean> {
  const [salt,hex] = stored.split(":");
  if (!salt || !hex) return false;
  const actual = await derive(password,salt,64) as Buffer, expected=Buffer.from(hex,"hex");
  return expected.length === actual.length && timingSafeEqual(actual,expected);
}
export async function newSession(pool:Database,userId:string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now()+7*24*60*60*1000).toISOString();
  await pool.query("INSERT INTO journal_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",[hashToken(token),userId,expiresAt]);
  return {token,expiresAt};
}
export function createAuthenticator(pool:Database, supabaseUrl?:string) {
  const issuer = supabaseUrl ? `${supabaseUrl.replace(/\/$/,"")}/auth/v1` : undefined;
  if (issuer && !issuer.startsWith("https://")) throw new Error("Supabase must use HTTPS");
  const keys = issuer ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`),{timeoutDuration:5000,cooldownDuration:30000}) : undefined;
  return async (token:string|undefined):Promise<string> => {
    assert(token && token.length <= 8192,"Sign in to continue",401);
    if (keys) {
      try {
        const {payload} = await jwtVerify(token,keys,{issuer,audience:"authenticated",algorithms:["ES256","RS256"]});
        assert(payload.role === "authenticated" && typeof payload.exp === "number","Invalid session",401);
        assert(typeof payload.sub === "string" && /^[0-9a-f-]{36}$/i.test(payload.sub),"Invalid session",401);
        await pool.query("INSERT INTO journal_users(id,email) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",[payload.sub,`supabase:${payload.sub}`]);
        return payload.sub;
      } catch { throw new ApiError(401,"Invalid or expired session"); }
    }
    const result=await pool.query<{user_id:string}>("SELECT user_id FROM journal_sessions WHERE token_hash=$1 AND expires_at>now()",[hashToken(token)]);
    assert(result.rows[0],"Invalid or expired session",401);
    return result.rows[0].user_id;
  };
}
export const newUserId = randomUUID;
