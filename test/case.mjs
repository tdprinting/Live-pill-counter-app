// reproduce a benchmark case exactly by seed: node test/case.mjs <set> <bg> <light> <layout> <seed>
import { analyze } from "../src/pillcv.js";
import { placePills, render, rng, writePNG } from "./synth.mjs";
const ODD={whiteRound:"peachRound",yellowOval:"whiteOval",capsuleRedWh:"capsuleBlueWh",whiteOblong:"whiteOval",blueRound:"greenRound",pinkOval:"orangeRound",whiteSmall:"whiteRound",capsuleYellow:"yellowOval"};
const [main,bg,light,layout,seedS]=process.argv.slice(2); const seed=+seedS, W=800,H=600;
const r=rng(seed), ppm=3+r()*1.6, count=12+Math.floor(r()*30), withOdd=seed%2===0;
const pills=placePills({main,count,odd:withOdd?[ODD[main]]:[],layout},r,W,H,ppm);
const rgba=render(pills,{W,H,bg,light},seed);
const res=analyze(rgba,W,H,{debug:true});
const Lb=res.debug.label;
console.log("truth",pills.length,"got",res.total,res.range,"unit",res.unitArea.toFixed(0),"rUnit",res.rUnit.toFixed(1),res.warnings.join(","));
for(const b of res.blobs){const t=pills.filter(p=>Lb[Math.round(p.y)*W+Math.round(p.x)]===b.id).length; if(t!==b.n) console.log(" blob",b.id,"truth",t,"n",b.n,b.conf,"nArea",b.nArea?.toFixed(2),"sol",b.solidity?.toFixed(2),"bbox",b.bbox.join(","));}
console.log("groups",res.groups.map(g=>`${g.count} ${g.role} ${g.colors} ${g.shape} asp${g.aspect?.toFixed(2)} tt${g.twoTone}`).join(" | "));
const img=new Uint8ClampedArray(rgba); const {fg}=res.debug;
for(let i=W;i<W*H-W;i++) if(fg[i]&&(!fg[i-1]||!fg[i+1]||!fg[i-W]||!fg[i+W])){img[4*i]=255;img[4*i+1]=255;img[4*i+2]=0;}
const dot=(x,y,c,rad)=>{for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){const X=Math.round(x+dx),Y=Math.round(y+dy);if(X<0||Y<0||X>=W||Y>=H||dx*dx+dy*dy>rad*rad)continue;const i=(Y*W+X)*4;img[i]=c[0];img[i+1]=c[1];img[i+2]=c[2];}};
for(const p of res.pills)dot(p.x,p.y,p.group>0?[255,0,255]:[255,0,0],3);
for(const t of pills)dot(t.x,t.y,[0,255,0],1);
writePNG("test/case.png",img,W,H);
