import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import { POST } from "../src/app/api/hosted/[...path]/route";
afterEach(() => vi.unstubAllGlobals());
const context = { params: Promise.resolve({ path: ["auth", "login"] }) };
const request = (origin: string) => new Request("http://localhost:3002/api/hosted/auth/login", {
  method: "POST", headers: { host: "192.168.2.39:3002", origin, "content-type": "application/json" }, body: "{}",
});
it("forwards device login through the proxy without leaking the browser Origin upstream", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({error: "Invalid request"}, {status: 400}));
  vi.stubGlobal("fetch", fetcher);
  expect((await POST(request("http://192.168.2.39:3002"), context)).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![1].headers.has("origin")).toBe(false);
});
it("rejects cross-site login before contacting the backend", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect((await POST(request("https://attacker.example"), context)).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
