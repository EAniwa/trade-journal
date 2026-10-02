export class HostedError extends Error {
  constructor(message:string,readonly status:number) { super(message); }
}
export async function hosted<T>(path:string,options:RequestInit={}):Promise<T> {
  const response=await fetch(`/api/hosted/${path}`,{...options,cache:"no-store",headers:{...(options.body?{"Content-Type":"application/json"}:{}),...options.headers}});
  const data=await response.json();
  if(!response.ok) throw new HostedError(data.error??"Request failed",response.status);
  return data as T;
}
export const hostedWrite=<T>(path:string,body:unknown,method="POST",key?:string)=>hosted<T>(path,{method,body:JSON.stringify(body),headers:key?{"Idempotency-Key":key}:{}});

/** getRandomValues also works in iOS WebViews on local HTTP previews. */
export function newImportKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
