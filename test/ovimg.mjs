import { analyze } from "../src/pillcv.js";
import { placePills, render, rng, writePNG } from "./synth.mjs";
const [main="whiteRound", bg="blueTray", light="even", seed="1"] = process.argv.slice(2);
const W=800,H=600, r=rng(+seed*13), ppm=3+r()*1.6, count=12+Math.floor(r()*30);
const pills=placePills({main,count,odd:[],layout:"overlap"},r,W,H,ppm);
const rgba=render(pills,{W,H,bg,light},+seed);
const res=analyze(rgba,W,H,{debug:true});
const {G}=res.debug, Tg=res.noise.Tg; const img=new Uint8ClampedArray(rgba);
for(let i=0;i<W*H;i++) if(G[i]>1.2*Tg){img[4*i]=255;img[4*i+1]=255;img[4*i+2]=0;}
for(const p of pills){const i=Math.round(p.y)*W+Math.round(p.x); for(const d of [0,1,-1,W,-W]){img[4*(i+d)]=0;img[4*(i+d)+1]=255;img[4*(i+d)+2]=0;}}
for(const p of res.pills){const i=Math.round(p.y+3)*W+Math.round(p.x); for(const d of [0,1,-1,W,-W]){img[4*(i+d)]=255;img[4*(i+d)+1]=0;img[4*(i+d)+2]=0;}}
writePNG("test/ov.png",img,W,H); console.log(pills.length,res.total,"cuts", res.noise);
