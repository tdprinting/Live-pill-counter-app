// dump per-clump features + truth for multi-pill blobs, to choose the split rule from data
import { analyze } from "../src/pillcv.js";
import { placePills, render, rng } from "./synth.mjs";
import fs from "node:fs";
const sets=["whiteRound","yellowOval","capsuleRedWh","whiteOblong","blueRound","pinkOval","capsuleYellow"];
const bgs=["blueTray","blackTray","grayTray","beigeCounter"], lights=["even","dim","sideLight","harsh","warm"];
const W=800,H=600, rows=[]; let seed=5000;
for(const set of sets)for(const layout of ["touching","overlap"])for(let k=0;k<6;k++){
  seed++; const r=rng(seed), bg=bgs[seed%4], light=lights[seed%5], ppm=3+r()*1.6, count=12+Math.floor(r()*30);
  const pills=placePills({main:set,count,odd:[],layout},r,W,H,ppm);
  const res=analyze(render(pills,{W,H,bg,light},seed),W,H,{debug:true,...JSON.parse(process.argv[2]||"{}")});
  const L=res.debug.label;
  for(const b of res.blobs){ if(!b.diag) continue; const t=pills.filter(p=>L[Math.round(p.y)*W+Math.round(p.x)]===b.id).length;
    rows.push({set,layout,truth:t,nArea:+b.nArea.toFixed(2),nMark:b.diag.nMark,nFit:b.diag.nFit,res:+b.diag.residual.toFixed(2),sol:+b.solidity.toFixed(2)}); }
}
fs.writeFileSync("test/blobdata.json",JSON.stringify(rows));
const acc=(f)=>{let ok=0;for(const r of rows) ok+=f(r)===r.truth; return (100*ok/rows.length).toFixed(1)+"%";};
console.log("rows",rows.length);
for(const lay of ["touching","overlap"]){ const R=rows.filter(r=>r.layout===lay); const a=(f)=>{let ok=0;for(const r of R) ok+=f(r)===r.truth; return (100*ok/R.length).toFixed(1)+"%";};
 console.log(lay,R.length,"fit",a(r=>r.nFit),"round",a(r=>Math.round(r.nArea)),"mark",a(r=>r.nMark),"ov72",a(r=>Math.round(r.nArea/0.72)),"maxMarkRound",a(r=>Math.max(r.nMark,Math.round(r.nArea)))); }
