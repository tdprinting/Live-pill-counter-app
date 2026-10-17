// run the engine on a PNG at native size and bilinear-upscaled
import { analyze } from "../src/pillcv.js";
import { readPNG } from "./synth.mjs";
const { rgba, W, H } = readPNG(process.argv[2]);
const scale = +(process.argv[3] || 2);
function resize(src, w, h, W2, H2) {
  const out = new Uint8ClampedArray(W2 * H2 * 4);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const fx = Math.min(w - 1.001, (x + 0.5) * w / W2 - 0.5), fy = Math.min(h - 1.001, (y + 0.5) * h / H2 - 0.5);
    const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy)), ax = Math.max(0, fx - x0), ay = Math.max(0, fy - y0);
    for (let c = 0; c < 4; c++) {
      const p = (xx, yy) => src[(yy * w + xx) * 4 + c];
      out[(y * W2 + x) * 4 + c] = (p(x0, y0) * (1 - ax) + p(x0 + 1, y0) * ax) * (1 - ay) + (p(x0, y0 + 1) * (1 - ax) + p(x0 + 1, y0 + 1) * ax) * ay;
    }
  }
  return out;
}
for (const s of [1, scale]) {
  const W2 = Math.round(W * s), H2 = Math.round(H * s), img = s === 1 ? rgba : resize(rgba, W, H, W2, H2);
  for (const fast of [true, false]) {
    const t = Date.now(); const r = analyze(img, W2, H2, { mode: "tray", fast });
    console.log(W2 + "x" + H2, fast ? "fast" : "full", "total", r.total, "ms", Date.now() - t, "unit", r.unitArea | 0, "rUnit", r.rUnit.toFixed(1), r.warnings.join(","), JSON.stringify(r.noise), r.blobs.filter((b) => b.n > 3).map((b) => [b.n, b.conf, b.nArea.toFixed(1)]).slice(0, 4));
  }
}
