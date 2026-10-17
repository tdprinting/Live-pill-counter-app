// same scenes with and without LiDAR depth
import { analyze } from "../src/pillcv.js";
import { placePills, render, renderDepth, rng } from "./synth.mjs";
const W = 800, H = 600, sets = ["whiteRound", "yellowOval", "capsuleRedWh", "pinkOval", "whiteOblong"];
const bgs = ["blueTray", "whitePlate", "blackTray", "grayTray"], lights = ["even", "dim", "harsh", "overhead"];
const layouts = (process.argv[2] || "spread,touching,overlap,pile").split(",");
for (const layout of layouts) {
  const acc = { rgb: [0, 0, 0], depth: [0, 0, 0] };
  let seed = 9000, n = 0;
  for (const set of sets) for (let k = 0; k < 4; k++) {
    seed++; n++;
    const r = rng(seed), ppm = 3 + r() * 1.6, count = 12 + Math.floor(r() * 25), bg = bgs[seed % 4], light = lights[(seed >> 2) % 4];
    const all = placePills({ main: set, count, odd: [], layout }, r, W, H, ppm);
    const img = render(all, { W, H, bg, light }, seed);
    const dep = renderDepth(all, { W, H, pxPerMm: ppm, seed });
    for (const [key, opts] of [["rgb", {}], ["depth", { depth: dep }]]) {
      const res = analyze(img, W, H, opts), e = res.total - all.length;
      acc[key][0] += e === 0; acc[key][1] += Math.abs(e) <= 1; acc[key][2] += Math.abs(e);
    }
  }
  const f = (a) => `exact ${(100 * a[0] / n).toFixed(0)}%  ±1 ${(100 * a[1] / n).toFixed(0)}%  MAE ${(a[2] / n).toFixed(2)}`;
  console.log(layout.padEnd(9), "camera only:", f(acc.rgb), " | with LiDAR:", f(acc.depth));
}
