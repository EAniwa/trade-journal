import {parseCsv,headerKey,toRecords} from "../csv";
import {parseDateAndTime} from "../dates";
import {parseMoney} from "../numbers";
import type {ImportFormat,ImportedExecution} from "../types";
const months:Record<string,string>={JA:"01",FE:"02",MR:"03",AP:"04",MY:"05",JN:"06",JL:"07",AG:"08",SE:"09",SP:"09",OC:"10",NO:"11",DE:"12"};
const required=["tradedate","settledate","description","action","quantity","price","commission","netamount"];
const headerIndex=(rows:string[][])=>rows.findIndex(row=>required.every(key=>row.map(headerKey).includes(key)));
export const tdDirect:ImportFormat={
  id:"td-direct",label:"TD Direct Investing (activity CSV)",
  detect:(_headers,content)=>headerIndex(parseCsv(content))>=0&&/TD Direct Investing/i.test(content),
  parse:(content,options)=>{
    const rows=parseCsv(content),start=headerIndex(rows),executions:ImportedExecution[]=[],errors:string[]=[];
    if(start<0)return {format:"td-direct",executions,skippedRows:0,warnings:[],errors:["TD activity column headers are missing."]};
    let skippedRows=0;
    // TD lists newest activity first; preserve its order for same-day fills.
    const records=toRecords(rows.slice(start)).reverse();
    for(const [order,row] of records.entries()){
      const action=row.action?.trim().toUpperCase()??"";
      if(!["BUY","SELL","EXPIRE"].includes(action)){skippedRows++;continue;}
      const description=row.description?.trim()??"";
      const option=description.match(/^(CALL|PUT)\s*-?\s*(\d+)\s*([A-Z][A-Z0-9.\/-]*)'(\d{2})\s*(\d{0,2})([A-Z]{2})\s*@?\s*(\d+(?:\.\d+)?)/i);
      let symbol="",multiplier=1;
      const expiry=description.match(/EXPIRES ON ([A-Z]{3}) (\d{1,2}),\s*(\d{4})/i);
      const expiryMonth=expiry?["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(expiry[1]!.toUpperCase())+1:0;
      const expiryDate=expiry&&expiryMonth?`${expiry[3]}-${String(expiryMonth).padStart(2,"0")}-${expiry[2]!.padStart(2,"0")}`:option&&option[5]&&months[option[6]!.toUpperCase()]?`20${option[4]}-${months[option[6]!.toUpperCase()]}-${option[5]!.padStart(2,"0")}`:null;
      if(option&&expiryDate){
        multiplier=Number(option[2]);symbol=`${option[3]!.toUpperCase()} ${expiryDate} ${option[1]!.toUpperCase()==="CALL"?"C":"P"}${Number(option[7])}`;
      }else if(!/^(CALL|PUT)/i.test(description))symbol=description.split(/\s+/)[0]??"";
      const signedQuantity=parseMoney(row.quantity),quantity=Math.abs(signedQuantity);
      const price=action==="EXPIRE"?0:parseMoney(row.price);
      const fee=row.commission?.trim()?Math.abs(parseMoney(row.commission)):0;
      const date=row.tradedate?.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
      const month=date? ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(date[2]!.toLowerCase())+1:0;
      const normalizedDate=date&&month?`${date[3]}-${String(month).padStart(2,"0")}-${date[1]!.padStart(2,"0")}`:row.tradedate;
      const executedAt=parseDateAndTime(normalizedDate,"00:00:00",options.timeZone);
      if(!symbol||!executedAt||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||!Number.isFinite(fee)||multiplier<=0){errors.push(`TD trade row ${order+1} could not be read. No trades were imported; check its description, date, quantity and price.`);continue;}
      executions.push({symbol,side:action==="BUY"?"buy":action==="SELL"?"sell":signedQuantity<0?"sell":"buy",quantity,price,fee,executedAt,assetClass:option?"option":"equity",importMetadata:{id:`td:${row.tradedate}:${description}:${action}:${row.quantity}:${row.price}:${row.commission}`,order,preserveFee:true,contractMultiplier:multiplier}});
    }
    return {format:"td-direct",executions,skippedRows,errors,warnings:["TD activity provides trade dates without execution times. Same-day trades retain statement order; cash transfers, interest and account fees are excluded from trade P&L."]};
  }
};
