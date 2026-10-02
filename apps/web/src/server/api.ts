import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { PolicyError, validateRequest } from "./request-policy";
import { AUTH_COOKIE, passwordConfigured, verifySession } from "./auth";

export class RequestError extends Error {}
export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RequestError(message);
}

export const ok = (data: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(data, { ...init, headers });
};

export const bad = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/** Route-handler wrapper: uniform error JSON instead of HTML 500 pages. */
export const handler =
  <A extends unknown[]>(
    fn: (...args: A) => Promise<Response> | Response,
    options: { public?: boolean } = {},
  ) =>
  async (...args: A): Promise<Response> => {
    const started = performance.now();
    const requestId = randomUUID();
    const finish = (response: Response) => {
      response.headers.set("X-Request-Id", requestId);
      response.headers.set("Server-Timing", `app;dur=${(performance.now() - started).toFixed(2)}`);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    };
    try {
      if (args[0] instanceof Request) validateRequest(args[0]);
      if (!options.public && passwordConfigured()) {
        const token = (await cookies()).get(AUTH_COOKIE)?.value;
        if (!verifySession(token)) return finish(bad("Unauthorized", 401));
      }
      return finish(await fn(...args));
    } catch (error) {
      const expected = error instanceof RequestError || error instanceof PolicyError;
      const message = expected ? error.message : "Internal server error";
      return finish(NextResponse.json(
        { error: message, requestId },
        { status: error instanceof PolicyError ? error.status : error instanceof RequestError ? 400 : 500 },
      ));
    }
  };
