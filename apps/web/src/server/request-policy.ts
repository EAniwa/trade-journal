export class PolicyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Next may use an internal hostname in request.url; Host is the browser-facing authority.
 * Do not trust forwarded host/protocol headers from arbitrary clients. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const external = new URL(request.url);
  const host = request.headers.get("host");
  if (host) {
    try {
      const parsed = new URL(`${external.protocol}//${host}`);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.host !== host) return false;
      external.host = parsed.host;
    } catch { return false; }
  }
  return origin === external.origin;
}

/** Cheap envelope checks before parsing large bodies or running broker work. */
export function validateRequest(request: Request): void {
  const url = new URL(request.url);
  if (url.search.length > 8192) throw new PolicyError("Query is too large", 414);
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (!isSameOrigin(request)) throw new PolicyError("Cross-origin request rejected", 403);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new PolicyError("Invalid content length", 400);
  const maximum = url.pathname === "/api/import" ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
  if (length !== null && Number(length) > maximum) throw new PolicyError("Request is too large", 413);
}

/** Local coalescing prevents duplicate simultaneous broker calls. No results are cached. */
export function singleFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const next = Promise.resolve().then(run).finally(() => {
      if (pending.get(key) === next) pending.delete(key);
    });
    pending.set(key, next);
    return next;
  };
}
