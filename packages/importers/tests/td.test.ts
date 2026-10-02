import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {parseAuto,detectFormat} from '../src/detect';
import {buildRoundTrips} from '@luxalgo/journal-core';
const header='As of Date,2026-09-26\nAccount,TD Direct Investing - example\n,\nTrade Date,Settle Date,Description,Action,Quantity,Price,Commission,Net Amount\n';
it('recognizes TD preambles, signed quantities, option identity and contract P&L',()=>{
 const csv=header+`25 Sep 2026,28 Sep 2026,"CALL-100 TEST'26 25SP@200 CLOSING TRANSACTION",SELL,-1,2.00,-11,189\n24 Sep 2026,25 Sep 2026,"CALL-100TEST'26 25SP@200 OPENING TRANSACTION",BUY,1,1.00,-11,-111\n24 Sep 2026,25 Sep 2026,INTEREST,INT,,,,-2\n`;
 expect(detectFormat(csv)?.id).toBe('td-direct');const parsed=parseAuto(csv,{timeZone:'America/Toronto'})!;
 expect(parsed.errors).toEqual([]);expect(parsed.skippedRows).toBe(1);expect(parsed.executions).toHaveLength(2);
 expect(parsed.executions[0]).toMatchObject({symbol:'TEST 2026-09-25 C200',side:'buy',quantity:1,fee:11,executedAt:'2026-09-24T04:00:00.000Z',importMetadata:{contractMultiplier:100}});
 const trades=buildRoundTrips(parsed.executions.map((e,i)=>({...e,id:String(i),accountId:'test',source:'import' as const})));
 expect(trades[0]).toMatchObject({grossPnl:100,fees:22,netPnl:78,contractMultiplier:100});
});
it('imports option expirations at zero and keeps puts separate from calls',()=>{
 const parsed=parseAuto(header+`25 Sep 2026,28 Sep 2026,CALL-100TEST'26 25SP200,EXPIRE,-1,,,\n24 Sep 2026,25 Sep 2026,PUT -100 TEST'26 25SP@200 OPENING TRANSACTION,BUY,1,0.5,-1,-51\n24 Sep 2026,25 Sep 2026,CALL-100TEST'26 25SP200 OPENING TRANSACTION,BUY,1,1,-1,-101\n`,{timeZone:'UTC'})!;
 expect(parsed.errors).toEqual([]);expect(parsed.executions[2]).toMatchObject({side:'sell',price:0});
 expect(new Set(parsed.executions.map(e=>e.symbol)).size).toBe(2);
});
it('reports unparseable trade rows instead of silently losing financial data',()=>{
 const parsed=parseAuto(header+`25 Sep 2026,28 Sep 2026,CALL UNKNOWN,BUY,1,2,-1,-201\n`,{timeZone:'UTC'})!;
 expect(parsed.errors).toHaveLength(1);
});
it.runIf(Boolean(process.env.TD_REAL_STATEMENT))('parses the supplied TD statement without exposing its data',()=>{
 const parsed=parseAuto(readFileSync(process.env.TD_REAL_STATEMENT!,'utf8'),{timeZone:'America/Toronto'})!;
 expect(parsed.format).toBe('td-direct');expect(parsed.errors).toEqual([]);expect(parsed.executions.length).toBeGreaterThan(0);
 expect(parsed.executions.every(e=>Number.isFinite(e.quantity)&&Number.isFinite(e.price))).toBe(true);
});
