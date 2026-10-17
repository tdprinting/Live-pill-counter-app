import { analyze } from "../src/pillcv.js";
import { placePills, render, rng, writePNG } from "./synth.mjs";
const [main, bg, light, layout, seed, out="test/dbg2.png"] = process.argv.slice(2);
const W=800,H=600, r=rng(+seed), ppm=3+r()*1.6, count=12+Math.floor(r()*30);
const pills=placePills({main,count,odd:[],layout},r,W,H,ppm);
const rgba=render(pills,{W,H,bg,light},+seed);
const res=analyze(rgba,W,H,{debug:true});
const {fg}=res.debug; const img=new Uint8ClampedArray(rgba);
for(let i=W;i<W*H-W;i++){ if(fg[i]&&(!fg[i-1]||!fg[i+1]||!fg[i-W]||!fg[i+W])){img[4*i]=255;img[4*i+1]=0;img[4*i+2]=0;} }
for(const p of res.pills){const i=Math.round(p.y)*W+Math.round(p.x); for(const d of [0,1,-1,W,-W]){img[4*(i+d)]=0;img[4*(i+d)+1]=200;img[4*(i+d)+2]=0;}}
// crop 400x300 around first pill
const cx=Math.max(0,Math.min(W-400,Math.round(pills[0].x-200))), cy=Math.max(0,Math.min(H-300,Math.round(pills[0].y-150)));
const crop=new Uint8ClampedArray(400*300*4); for(let y=0;y<300;y++)for(let x=0;x<400;x++)for(let c=0;c<4;c++)crop[(y*400+x)*4+c]=img[((y+cy)*W+x+cx)*4+c];
writePNG(out,crop,400,300); console.log(pills.length,res.total);
