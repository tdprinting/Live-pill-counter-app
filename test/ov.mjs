import { analyze } from "../src/pillcv.js";
import { placePills, render, rng } from "./synth.mjs";
// per-blob diagnostics for overlap scenes: truth pills per blob vs estimate
const [main="whiteRound", bg="blueTray", light="even"] = process.argv.slice(2);
const W=800,H=600; let rows=[];
for (let seed=1; seed<=12; seed++){
  const r=rng(seed*13), ppm=3+r()*1.6, count=12+Math.floor(r()*30);
  const pills=placePills({main,count,odd:[],layout:"overlap"},r,W,H,ppm);
  const res=analyze(rgbaOf(pills,seed),W,H,{debug:true});
  function rgbaOf(p,s){return render(p,{W,H,bg,light},s);}
  const lab=new Map(); // blob id at each truth centre
  const {fg}=res.debug;
  const L=res.debug.label; for(const b of res.blobs){ const t=pills.filter(p=>L[Math.round(p.y)*W+Math.round(p.x)]===b.id).length; rows.push([t,b.n,b.nArea?.toFixed(2),b.conf,b.solidity?.toFixed(2)]); }
  console.log(seed,"truth",pills.length,"got",res.total);
}
const bad=rows.filter(r=>r[0]!==r[1]); console.log("blobs",rows.length,"wrong",bad.length); console.log(bad.map(r=>r.join(":")).join("  "));
