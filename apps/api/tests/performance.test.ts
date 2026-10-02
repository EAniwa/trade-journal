import {expect,it} from 'vitest';
import {performanceWindow,accountPerformance,PERIODS} from '../src/performance';
import {buildRoundTrips} from '@luxalgo/journal-core';
it('uses calendar windows, clamps month ends, and includes the ending local day',()=>{
 expect(performanceWindow('1d','UTC','2026-10-01')).toEqual({from:'2026-10-01',to:'2026-10-01'});
 expect(performanceWindow('1w','UTC','2026-10-01').from).toBe('2026-09-25');
 expect(performanceWindow('2w','UTC','2026-10-01').from).toBe('2026-09-18');
 expect(performanceWindow('1m','UTC','2026-03-31').from).toBe('2026-03-01');
 expect(performanceWindow('3m','UTC','2026-10-01').from).toBe('2026-07-02');
 expect(performanceWindow('6m','UTC','2026-10-01').from).toBe('2026-04-02');
 expect(performanceWindow('1y','UTC','2026-10-01').from).toBe('2025-10-02');
 expect(performanceWindow('all','UTC','2026-10-01').from).toBeNull();
 for(const date of ['2026-99-01','2026-02-30','bad'])expect(()=>performanceWindow('1m','UTC',date)).toThrow();
 expect(PERIODS).toHaveLength(8);
});
it('groups realized performance by symbol and explicit sector in journal timezone',()=>{
 const fills=[{id:'1',accountId:'account',symbol:'TEST',side:'buy' as const,quantity:1,price:10,fee:0,executedAt:'2026-09-30T23:00:00Z',source:'manual' as const},{id:'2',accountId:'account',symbol:'TEST',side:'sell' as const,quantity:1,price:15,fee:1,executedAt:'2026-10-01T02:00:00Z',source:'manual' as const}];
 const trades=buildRoundTrips(fills).map(t=>({...t,annotations:{sector:'Technology'}}));
 const report=accountPerformance(trades,'CAD',1000,'America/Toronto',{from:'2026-09-30',to:'2026-09-30'});
 expect(report).toMatchObject({moneyMade:4,moneyLost:0,currencies:['CAD'],sectors:[{name:'Technology',netPnl:4}],symbols:[{name:'TEST',netPnl:4}],metrics:{closedTrades:1,netPnl:4}});
 expect(accountPerformance(trades,'CAD',1000,'UTC',{from:'2026-09-30',to:'2026-09-30'}).metrics.closedTrades).toBe(0);
});
