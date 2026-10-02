import { afterEach, describe, expect, it, vi } from "vitest";
import { handler, ok } from "../src/server/api";
import { sessionToken, verifyPassword } from "../src/server/auth";

const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  session.token = undefined;
});

describe("optional journal password protection", () => {
  it("permits local access when no password is configured", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "");
    expect((await handler(() => ok({ data: true }))()).status).toBe(200);
  });
  it("rejects both missing and forged cookies before executing any handler", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    const action = vi.fn(() => ok({ secret: true }));
    for (const token of [undefined, "forged", "0".repeat(64)]) {
      session.token = token;
      expect((await handler(action)()).status).toBe(401);
    }
    expect(action).not.toHaveBeenCalled();
  });
  it("accepts signed sessions and invalidates them when the password changes", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    session.token = sessionToken();
    expect((await handler(() => ok({ data: true }))()).status).toBe(200);
    vi.stubEnv("JOURNAL_PASSWORD", "new-password");
    expect((await handler(() => ok({ data: true }))()).status).toBe(401);
  });
  it("allows the login endpoint to verify a password without a session", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    expect(verifyPassword("test-password")).toBe(true);
    expect(verifyPassword("wrong-password")).toBe(false);
    expect((await handler(() => ok({ login: true }), { public: true })()).status).toBe(200);
  });
});


describe("API diagnostics", () => {
  it("returns timing and a request identifier without leaking internal errors", async () => {
    const response = await handler(() => { throw new Error("postgres://private-secret"); })();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal server error");
    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(response.headers.get("Server-Timing")).toMatch(/^app;dur=\d+\.\d{2}$/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rejects an oversized request before running its action", async () => {
    const action = vi.fn((_request: Request) => ok({ saved: true }));
    const response = await handler(action)(new Request("https://journal.example/api/executions", {
      method: "POST", headers: { "content-length": "99999999" },
    }));
    expect(response.status).toBe(413);
    expect(action).not.toHaveBeenCalled();
  });
});
