import { describe, expect, it, vi } from "vitest";
import { PolicyError, singleFlight, validateRequest } from "../src/server/request-policy";

describe("request envelope", () => {
  it("allows same-origin writes and native clients without Origin", () => {
    for (const headers of [new Headers(), new Headers({ origin: "https://journal.example" })])
      expect(() => validateRequest(new Request("https://journal.example/api/trades", { method: "POST", headers }))).not.toThrow();
  });
  it("rejects cross-origin writes but allows reads", () => {
    const headers = { origin: "https://attacker.example" };
    expect(() => validateRequest(new Request("https://journal.example/api/trades", { method: "POST", headers }))).toThrow(PolicyError);
    expect(() => validateRequest(new Request("https://journal.example/api/trades", { headers }))).not.toThrow();
  });
  it("accepts the device Host despite an internal localhost URL, without trusting forwarded headers", () => {
    const request = (origin: string, extra = {}) => new Request("http://localhost:3002/api/trades", {
      method: "POST", headers: { host: "192.168.2.39:3002", origin, ...extra },
    });
    expect(() => validateRequest(request("http://192.168.2.39:3002"))).not.toThrow();
    for (const origin of ["https://attacker.example", "http://192.168.2.39:3003", "https://192.168.2.39:3002", "null"])
      expect(() => validateRequest(request(origin, { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" }))).toThrow(PolicyError);
    expect(() => validateRequest(request("http://attacker.example", {host: "192.168.2.39:3002/ignored"}))).toThrow(PolicyError);
  });
  it("rejects invalid sizes and oversize envelopes", () => {
    for (const length of ["-1", "hello", "9007199254740992", "20971521"])
      expect(() => validateRequest(new Request("https://journal.example/api/import", { method: "POST", headers: { "content-length": length } }))).toThrow(PolicyError);
    expect(() => validateRequest(new Request("https://journal.example/api/import", { method: "POST", headers: { "content-length": "20971520" } }))).not.toThrow();
    expect(() => validateRequest(new Request("https://journal.example/api/trades?q=" + "a".repeat(8192)))).toThrow(PolicyError);
  });
});

describe("broker single flight", () => {
  it("shares simultaneous work, isolates accounts, and performs fresh work afterwards", async () => {
    const run = vi.fn(async () => 42);
    const flight = singleFlight<number>();
    const a = flight("a", run), b = flight("a", run), c = flight("b", run);
    expect(a).toBe(b); expect(c).not.toBe(a);
    expect(await Promise.all([a,b,c])).toEqual([42,42,42]);
    expect(run).toHaveBeenCalledTimes(2);
    await flight("a", run); expect(run).toHaveBeenCalledTimes(3);
  });
  it("clears rejected jobs so a retry can succeed", async () => {
    const flight = singleFlight<number>();
    await expect(flight("a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(flight("a", async () => 7)).resolves.toBe(7);
  });
});
