import {computeOverview,computeEdgeScore,dayKeyOf,type AnnotatedTrade} from "@luxalgo/journal-core";
import {assert} from "./errors";
export const PERIODS=["1d","1w","2w","1m","3m","6m","1y","all"] as const;
export type Period=typeof PERIODS[number];
export function performanceWindow(period:Period,timeZone:string,asOf?:string){
 const to=asOf??dayKeyOf(new Date().toISOString(),timeZone);
 assert(/^\d{4}-\d{2}-\d{2}$/.test(to)&&Number.isFinite(Date.parse(to+"T00:00:00Z"))&&new Date(to+"T00:00:00Z").toISOString().slice(0,10)===to,"Invalid performance end date");
 if(period==="all")return {from:null,to};
 const end=new Date(to+"T00:00:00Z"),start=new Date(end);
 if(["1d","1w","2w"].includes(period))start.setUTCDate(start.getUTCDate()-({"1d":0,"1w":6,"2w":13}[period as "1d"|"1w"|"2w"]));
 else {const months={"1m":1,"3m":3,"6m":6,"1y":12}[period as "1m"|"3m"|"6m"|"1y"];const day=start.getUTCDate();start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()-months);start.setUTCDate(Math.min(day,new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate()));start.setUTCDate(start.getUTCDate()+1);}
 return {from:start.toISOString().slice(0,10),to};
}
export function accountPerformance(trades:AnnotatedTrade[],currency:string,initialBalance:number,timeZone:string,window:{from:string|null;to:string}){
 const filtered=trades.filter(t=>{const date=dayKeyOf(t.closedAt??t.openedAt,timeZone);return (!window.from||date>=window.from)&&date<=window.to;});
 const overview=computeOverview(filtered,{timeZone,initialBalance});
 const closed=filtered.filter(t=>t.status!=="open");
 const breakdown=(key:(t:AnnotatedTrade)=>string)=>{const values=new Map<string,{name:string;trades:number;netPnl:number;wins:number}>();for(const t of closed){const name=key(t);const item=values.get(name)??{name,trades:0,netPnl:0,wins:0};item.trades++;item.netPnl+=t.netPnl;if(t.netPnl>0)item.wins++;values.set(name,item);}return [...values.values()].sort((a,b)=>b.netPnl-a.netPnl);};
 return {...overview,currencies:[currency],timeZone,window,initialBalance,edgeScore:computeEdgeScore(overview.metrics),moneyMade:closed.reduce((n,t)=>n+Math.max(0,t.netPnl),0),moneyLost:closed.reduce((n,t)=>n+Math.abs(Math.min(0,t.netPnl)),0),symbols:breakdown(t=>t.symbol.split(" ")[0]!),sectors:breakdown(t=>t.annotations?.sector?.trim()||"Unclassified"),updatedAt:new Date().toISOString()};
}
