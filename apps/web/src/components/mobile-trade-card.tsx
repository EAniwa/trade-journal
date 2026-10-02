"use client";
import Link from "next/link";
import { dayKeyOf } from "@luxalgo/journal-core";
import { Pnl } from "./pnl";
import { Checkbox } from "./ui/checkbox";
import { Badge } from "./ui/badge";
import { fmtDuration } from "@/lib/utils";

interface MobileTrade {
  key: string; symbol: string; direction: string; status: string;
  closedAt: string | null; netPnl: number; durationMs: number | null; reviewed: boolean;
}
export function MobileTradeCard({ trade, query, timeZone, selected, onSelected }: {
  trade: MobileTrade; query: string; timeZone: string; selected: boolean;
  onSelected: (value: boolean) => void;
}) {
  return <article className="journal-trade-card">
    <Checkbox aria-label={`Select ${trade.symbol} trade`} checked={selected}
      onCheckedChange={(value) => onSelected(value === true)} />
    <Link href={`/trades/${encodeURIComponent(trade.key)}${query ? `?${query}` : ""}`}
      className="min-w-0 flex-1 space-y-2" aria-label={`Review ${trade.symbol} ${trade.direction} trade`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{trade.symbol} <span className="ml-1 text-xs font-normal text-muted-foreground">{trade.direction}</span></span>
        <Pnl value={trade.netPnl} className="text-base font-semibold" />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{trade.closedAt ? dayKeyOf(trade.closedAt, timeZone) : "Open position"}</span>
        <Badge variant={trade.status === "win" ? "profit" : trade.status === "loss" ? "loss" : "secondary"}>{trade.status.toUpperCase()}</Badge>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{trade.durationMs === null ? "In progress" : fmtDuration(trade.durationMs)}</span>
        <span>{trade.reviewed ? "Reviewed" : "Review trade →"}</span>
      </div>
    </Link>
  </article>;
}
