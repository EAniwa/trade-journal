// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileTradeCard } from "../src/components/mobile-trade-card";
const trade = { key:"account|AAPL|long", symbol:"AAPL", direction:"long", status:"loss", closedAt:"2026-09-30T00:30:00Z", netPnl:-42, durationMs:60000, reviewed:false };
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); container=document.createElement("div"); document.body.append(container); root=createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("links to the correct trade, preserves filters, and renders the journal timezone", async () => {
  await act(async () => root.render(createElement(MobileTradeCard,{trade,query:"range=30d",timeZone:"America/Toronto",selected:false,onSelected:vi.fn()})));
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/trades/account%7CAAPL%7Clong?range=30d");
  expect(container.textContent).toContain("2026-09-29");
  expect(container.textContent).toContain("LOSS");
});
it("supports bulk selection independently of opening the trade", async () => {
  const onSelected=vi.fn();
  await act(async () => root.render(createElement(MobileTradeCard,{trade,query:"",timeZone:"UTC",selected:false,onSelected})));
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  expect(onSelected).toHaveBeenCalledWith(true);
});
it("labels open and reviewed positions without inventing a close date", async () => {
  await act(async () => root.render(createElement(MobileTradeCard,{trade:{...trade,closedAt:null,durationMs:null,reviewed:true,status:"open"},query:"",timeZone:"UTC",selected:false,onSelected:vi.fn()})));
  expect(container.textContent).toContain("Open position");
  expect(container.textContent).toContain("In progress");
  expect(container.textContent).toContain("Reviewed");
});
