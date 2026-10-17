import { analyze } from "../src/pillcv.js";
import { placePills, render, rng, writePNG } from "./synth.mjs";
const [main, bg, light, layout, seed] = process.argv.slice(2);
const W=800,H=600, r=rng(+seed), ppm=3+r()*1.6, count=12+Math.floor(r()*30);
const pills=placePills({main,count,odd:[],layout},r,W,H,ppm);
const rgba=render(pills,{W,H,bg,light},+seed);
const res=analyze(rgba,W,H,{debug:true});
const {D,G,fg}=res.debug; console.log(res.noise);
const p=pills[0]; const i=Math.round(p.y)*W+Math.round(p.x);
let line=[];for(let dx=-20;dx<=20;dx+=2){const j=i+dx;line.push(`${D[j].toFixed(0)}/${G[j].toFixed(1)}`)}console.log(line.join(" "));
const img=new Uint8ClampedArray(W*H*4);
for(let k=0;k<W*H;k++){img[4*k]=Math.min(255,D[k]/res.noise.Td*128);img[4*k+1]=Math.min(255,G[k]/res.noise.Tg*128);img[4*k+2]=fg[k]*255;img[4*k+3]=255;}
writePNG("test/dbg.png",img,W,H);
