// Synthetic "phone photo of pills on a tray" generator with ground truth.
// Renders shaded 3D-ish tablets/capsules with bevels, soft cast shadows, specular
// highlights, uneven lighting, colour casts, sensor noise and slight blur.
import zlib from "node:zlib";
import fs from "node:fs";

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

// mm sizes; colours in sRGB 0..255
export const PILL_TYPES = {
  whiteRound:   { shape: "round",   len: 8,  wid: 8,   color: [238, 236, 230] },
  whiteSmall:   { shape: "round",   len: 6,  wid: 6,   color: [240, 238, 232] },
  whiteOblong:  { shape: "stadium", len: 17, wid: 7.5, color: [236, 234, 228] },
  whiteOval:    { shape: "ellipse", len: 11, wid: 6,   color: [235, 233, 226] },
  yellowOval:   { shape: "ellipse", len: 10, wid: 5.5, color: [236, 205, 90] },
  pinkOval:     { shape: "ellipse", len: 10, wid: 5,   color: [232, 160, 170] },
  blueRound:    { shape: "round",   len: 9,  wid: 9,   color: [90, 140, 205] },
  peachRound:   { shape: "round",   len: 8,  wid: 8,   color: [240, 190, 150] },
  orangeRound:  { shape: "round",   len: 8,  wid: 8,   color: [235, 140, 60] },
  capsuleRedWh: { shape: "stadium", len: 18, wid: 6.5, color: [200, 50, 50], color2: [240, 238, 232] },
  capsuleYellow:{ shape: "stadium", len: 19, wid: 7,   color: [235, 200, 70], color2: [235, 200, 70] },
  capsuleBlueWh:{ shape: "stadium", len: 16, wid: 6,   color: [60, 90, 170], color2: [235, 235, 235] },
  greenRound:   { shape: "round",   len: 7,  wid: 7,   color: [120, 180, 120] },
};

export const BACKGROUNDS = {
  whitePlate: [242, 242, 238],
  blueTray:   [55, 105, 170],
  blackTray:  [32, 33, 36],
  grayTray:   [140, 142, 145],
  beigeCounter: [210, 195, 170],
};

export const LIGHTING = {
  even:      { gain: 1.0,  grad: 0.05, vignette: 0.10, cast: [1, 1, 1],         noise: 2,  shadow: 0.25, light: [-0.5, -0.6], blur: 0 },
  dim:       { gain: 0.35, grad: 0.10, vignette: 0.25, cast: [1, 0.97, 0.9],    noise: 7,  shadow: 0.2,  light: [-0.4, -0.5], blur: 1 },
  veryDim:   { gain: 0.18, grad: 0.10, vignette: 0.3,  cast: [1, 0.95, 0.85],   noise: 9,  shadow: 0.15, light: [-0.4, -0.5], blur: 1 },
  sideLight: { gain: 1.0,  grad: 0.55, vignette: 0.15, cast: [1, 1, 1],         noise: 3,  shadow: 0.45, light: [-0.9, -0.2], blur: 0 },
  warm:      { gain: 0.8,  grad: 0.15, vignette: 0.15, cast: [1.08, 0.95, 0.72], noise: 4,  shadow: 0.3,  light: [-0.3, -0.7], blur: 0 },
  cool:      { gain: 0.95, grad: 0.10, vignette: 0.10, cast: [0.9, 0.98, 1.12],  noise: 3,  shadow: 0.25, light: [0.4, -0.6],  blur: 0 },
  harsh:     { gain: 1.1,  grad: 0.25, vignette: 0.10, cast: [1, 1, 1],         noise: 2,  shadow: 0.6,  light: [-0.8, -0.8], blur: 0 },
  overhead:  { gain: 1.0,  grad: 0.08, vignette: 0.12, cast: [1, 1, 1],         noise: 2,  shadow: 0.12, light: [0, -0.15],  blur: 0, glare: true },
};

function sdfWhole(px, py, p) {
  // signed distance (px) of point to the pill outline; negative inside
  const dx = px - p.x, dy = py - p.y;
  const c = Math.cos(-p.rot), s = Math.sin(-p.rot);
  const u = dx * c - dy * s, v = dx * s + dy * c;
  const a = p.lenPx / 2, b = p.widPx / 2;
  if (p.shape === "round") return Math.hypot(u, v) - a;
  if (p.shape === "ellipse") { const k = Math.hypot(u / a, v / b); return (k - 1) * Math.min(a, b) * (k > 0 ? 1 : 1); }
  // stadium
  const half = a - b, cu = Math.max(-half, Math.min(half, u));
  return Math.hypot(u - cu, v) - b;
}
function sdf(px, py, p) {
  const d = sdfWhole(px, py, p);
  if (!p.broken) return d;
  // broken tablet: keep one side of a slightly jagged cut line
  const dx = px - p.x, dy = py - p.y;
  const u = dx * Math.cos(-p.rot) - dy * Math.sin(-p.rot), v = dx * Math.sin(-p.rot) + dy * Math.cos(-p.rot);
  const cut = u - p.cutAt * p.lenPx / 2 + 0.6 * Math.sin(v * 0.9);
  return Math.max(d, cut);
}
function localU(px, py, p) { const dx = px - p.x, dy = py - p.y; return dx * Math.cos(-p.rot) - dy * Math.sin(-p.rot); }

export function placePills(spec, r, W, H, pxPerMm) {
  // spec: { main: typeName, count, odd: [typeName...], layout: 'spread'|'touching'|'overlap'|'mixed' }
  const list = [];
  const types = [...Array(spec.count).fill(spec.main), ...(spec.odd || []), ...Array(spec.broken || 0).fill("#broken")];
  for (let k = types.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [types[k], types[j]] = [types[j], types[k]]; }
  const area = { x0: W * 0.12, y0: H * 0.12, x1: W * 0.88, y1: H * 0.88 };
  for (const t of types) {
    const isBroken = t === "#broken";
    const T = PILL_TYPES[isBroken ? spec.main : t];
    const p = { type: t, shape: T.shape, lenPx: T.len * pxPerMm * (1 + 0.02 * gauss(r)), widPx: T.wid * pxPerMm, color: T.color, color2: T.color2, rot: r() * Math.PI, odd: !isBroken && t !== spec.main, broken: isBroken, cutAt: -0.1 + 0.3 * r() };
    const R = p.lenPx / 2;
    let placed = false;
    for (let tries = 0; tries < 400 && !placed; tries++) {
      let mode = spec.layout;
      if (mode === "mixed") mode = r() < 0.5 ? "spread" : r() < 0.6 ? "touching" : "overlap";
      if ((mode === "touching" || mode === "overlap" || mode === "pile") && list.length && r() < (mode === "pile" ? 0.95 : 0.65)) {
        const q = list[Math.floor(r() * list.length)];
        const ang = r() * 2 * Math.PI;
        // walk outward from q until we just touch (or overlap) — uses true outlines
        const want = mode === "touching" ? 0.5 : -(mode === "pile" ? 0.4 + 0.45 * r() : 0.25 + 0.3 * r()) * Math.min(p.widPx, q.widPx);
        // come in from outside until the outlines touch / overlap by the wanted amount
        for (let d = 1.2 * (R + q.lenPx); d > 0; d -= 0.5) {
          p.x = q.x + Math.cos(ang) * d; p.y = q.y + Math.sin(ang) * d;
          if (minGap(p, q) <= want) break;
        }
      } else {
        p.x = area.x0 + R + r() * (area.x1 - area.x0 - 2 * R);
        p.y = area.y0 + R + r() * (area.y1 - area.y0 - 2 * R);
      }
      if (p.x < area.x0 || p.x > area.x1 || p.y < area.y0 || p.y > area.y1) continue;
      let ok = true;
      for (const q of list) {
        const g = minGap(p, q);
        if (mode === "spread" && g < 3) ok = false;
        if (mode === "touching" && g < -0.5) ok = false;
        if (mode === "overlap" && g < -0.6 * Math.min(p.widPx, q.widPx)) ok = false; // keep each pill mostly visible
        if (mode === "pile" && g < -0.9 * Math.min(p.widPx, q.widPx)) ok = false;
        if (!ok) break;
      }
      if (ok && (mode === "overlap" || mode === "pile")) {
        // overlap: every pill stays >= 55% visible. pile: >= 25% (stacked; hard even for people)
        const after = [...list, p], minVis = mode === "pile" ? 0.25 : 0.55;
        for (let k = 0; k < list.length && ok; k++) if (visibleFrac(list[k], after.slice(k + 1)) < minVis) ok = false;
      }
      if (ok) placed = true;
    }
    if (placed) list.push(p);
  }
  return list;
}
function visibleFrac(p, above) {
  if (!above.length) return 1;
  let tot = 0, vis = 0;
  for (let y = p.y - p.lenPx / 2; y <= p.y + p.lenPx / 2; y += 1.5) for (let x = p.x - p.lenPx / 2; x <= p.x + p.lenPx / 2; x += 1.5) {
    if (sdf(x, y, p) > 0) continue;
    tot++;
    if (!above.some((q) => sdf(x, y, q) <= 0)) vis++;
  }
  return tot ? vis / tot : 1;
}
function minGap(p, q) {
  // approximate gap between outlines by sampling q's outline against p's sdf
  let g = Infinity;
  for (let k = 0; k < 48; k++) {
    const ang = (k / 48) * 2 * Math.PI;
    // march from q centre along ang to its boundary
    let d = 0; while (sdf(q.x + Math.cos(ang) * d, q.y + Math.sin(ang) * d, q) < 0 && d < 500) d += 0.5;
    const bx = q.x + Math.cos(ang) * d, by = q.y + Math.sin(ang) * d;
    g = Math.min(g, sdf(bx, by, p));
  }
  return g;
}

export function render(pills, opts, seed = 1) {
  const { W, H, bg, light } = opts;
  const r = rng(seed * 7 + 3);
  const L = LIGHTING[light];
  const base = BACKGROUNDS[bg];
  const lin = (c) => Math.pow(c / 255, 2.2);
  const img = new Float32Array(W * H * 3);
  // shadow mask
  const sh = new Float32Array(W * H);
  const off = [-L.light[0] * 5, -L.light[1] * 5];
  for (const p of pills) {
    const q = { ...p, x: p.x + off[0] * (p.widPx / 25), y: p.y + off[1] * (p.widPx / 25) };
    const [x0, y0, x1, y1] = [q.x - q.lenPx, q.y - q.lenPx, q.x + q.lenPx, q.y + q.lenPx].map(Math.round);
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const d = sdf(x, y, q), soft = 0.18 * q.widPx;
      const v = Math.max(0, Math.min(1, 0.5 - d / (2 * soft)));
      sh[y * W + x] = Math.max(sh[y * W + x], v);
    }
  }
  // texture for counters
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W - 0.5, v = y / H - 0.5;
    const illum = L.gain * (1 + L.grad * (-(L.light[0]) * u * 2 + -(L.light[1]) * v * 2) * 0.5) * (1 - L.vignette * (u * u + v * v) * 2.2);
    let tex = 1;
    if (bg === "beigeCounter") tex = 1 + 0.03 * Math.sin(x * 0.05 + Math.sin(y * 0.02) * 3) + 0.02 * gauss(r);
    const shade = 1 - L.shadow * sh[y * W + x];
    for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = lin(base[c]) * illum * tex * shade * L.cast[c];
    if (L.glare) { const gd = Math.hypot(x - W * 0.62, y - H * 0.3); const gl = Math.exp(-(gd * gd) / (2 * (W * 0.06) ** 2)) * 0.5; for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] += gl * illum; }
  }
  // pills
  const lx = L.light[0], ly = L.light[1], lz = 0.8, ln = Math.hypot(lx, ly, lz);
  for (const p of pills) {
    const [x0, y0, x1, y1] = [p.x - p.lenPx, p.y - p.lenPx, p.x + p.lenPx, p.y + p.lenPx].map(Math.round);
    const bevel = 0.3 * (p.widPx / 2);
    const isCaps = !!p.color2;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const d = sdf(x, y, p);
      const cover = Math.max(0, Math.min(1, 0.5 - d));
      if (cover <= 0) continue;
      // normal: tilt outward near the edge (capsules are fully round in cross-section)
      const e = 0.7;
      const gx = sdf(x + e, y, p) - sdf(x - e, y, p), gy = sdf(x, y + e, p) - sdf(x, y - e, p);
      const gn = Math.hypot(gx, gy) || 1;
      const depth = -d;
      const t = isCaps ? Math.max(0, 1 - depth / (p.widPx / 2)) : Math.max(0, 1 - depth / bevel);
      const tilt = isCaps ? Math.asin(Math.min(1, t)) : t * 1.1 + 0.08;
      const nx = (gx / gn) * Math.sin(tilt), ny = (gy / gn) * Math.sin(tilt), nz = Math.cos(tilt);
      const diff = Math.max(0, (nx * lx + ny * ly + nz * lz) / ln);
      const hx = lx / ln, hy = ly / ln, hz = lz / ln + 1, hn = Math.hypot(hx, hy, hz);
      const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hn), 40) * (isCaps ? 0.35 : 0.12);
      const u = x - p.x, vv = y - p.y;
      const col = isCaps && localU(x, y, p) > 0 ? p.color2 : p.color;
      void u; void vv;
      const ux = x / W - 0.5, uy = y / H - 0.5;
      const illum = L.gain * (1 + L.grad * (-(lx) * ux * 2 + -(ly) * uy * 2) * 0.5) * (1 - L.vignette * (ux * ux + uy * uy) * 2.2);
      const k = (0.45 + 0.6 * diff) * illum;
      for (let c = 0; c < 3; c++) {
        const i = (y * W + x) * 3 + c;
        const v = lin(col[c]) * k * L.cast[c] + spec * illum;
        img[i] = img[i] * (1 - cover) + v * cover;
      }
    }
  }
  // blur
  let out = img;
  if (L.blur) {
    const tmp = new Float32Array(img.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let c = 0; c < 3; c++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += img[((y + dy) * W + x + dx) * 3 + c];
      tmp[(y * W + x) * 3 + c] = s / 9;
    }
    out = tmp;
  }
  // camera auto-exposure: bring the median up toward mid-grey (phones do this), then noise + gamma
  const lum = []; for (let i = 0; i < W * H; i += 37) lum.push(out[i * 3] * 0.3 + out[i * 3 + 1] * 0.6 + out[i * 3 + 2] * 0.1);
  lum.sort((a, b) => a - b);
  const med = lum[lum.length >> 1];
  // phones expose bright scenes bright and dark trays dark-ish (not to mid grey)
  const target = { whitePlate: 0.5, beigeCounter: 0.4, grayTray: 0.22, blueTray: 0.16, blackTray: 0.05 }[bg] ?? 0.18;
  const aeGain = Math.min(4, Math.max(0.6, target / Math.max(1e-4, med)));
  const noiseAmp = L.noise * (L.gain < 0.5 ? Math.sqrt(aeGain) : 1);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.pow(Math.max(0, out[i * 3 + c] * aeGain), 1 / 2.2) * 255 + gauss(r) * noiseAmp;
      rgba[i * 4 + c] = v;
    }
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

// --- tiny PNG writer for eyeballing results ---
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePNG(path, rgba, W, H) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
export function readPNG(path) {
  const buf = fs.readFileSync(path);
  let pos = 8, W = 0, H = 0, bpp = 4, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bpp = data[9] === 6 ? 4 : 3; }
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = W * bpp, out = new Uint8ClampedArray(W * H * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let p = v;
      if (f === 1) p = v + a; else if (f === 2) p = v + b; else if (f === 3) p = v + ((a + b) >> 1);
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[x] = p & 255;
    }
    for (let x = 0; x < W; x++) { out[(y * W + x) * 4] = cur[x * bpp]; out[(y * W + x) * 4 + 1] = cur[x * bpp + 1]; out[(y * W + x) * 4 + 2] = cur[x * bpp + 2]; out[(y * W + x) * 4 + 3] = 255; }
    prev.set(cur);
  }
  return { rgba: out, W, H };
}

// --- LiDAR-style depth for the same scene (iPhone Pro: 256x192 depth, ~mm noise) ---
// Pills rest on what is under them, so stacks really are taller. Returns depth in metres
// at sensor resolution plus intrinsics in image-pixel units (what ARKit gives after scaling).
export function renderDepth(pills, { W, H, pxPerMm, seed = 1, camZmm = 280, tilt = [0.04, -0.03], noiseMm = 0.8 }) {
  const r = rng(seed * 13 + 5);
  const hm = new Float32Array(W * H); // height above tray, mm
  for (const p of pills) {
    const [x0, y0, x1, y1] = [p.x - p.lenPx, p.y - p.lenPx, p.x + p.lenPx, p.y + p.lenPx].map(Math.round);
    const caps = !!p.color2 || p.shape === "stadium";
    const thick = (caps ? 1.0 : 0.45) * (p.widPx / pxPerMm);
    // rest on the highest thing under the middle of the pill
    let base = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) if (sdf(x, y, p) < -0.25 * p.widPx) base = Math.max(base, hm[y * W + x]);
    base *= 0.85;
    const rad = p.widPx / 2, bevel = 0.3 * rad;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const d = sdf(x, y, p);
      if (d > 0) continue;
      const depth = -d;
      const prof = caps ? Math.sqrt(Math.max(0, 1 - (1 - Math.min(1, depth / rad)) ** 2)) : Math.min(1, 0.55 + 0.45 * depth / bevel);
      const hh = base + thick * prof;
      if (hh > hm[y * W + x]) hm[y * W + x] = hh;
    }
  }
  const dw = 256, dh = Math.round((256 * H) / W), sx = W / dw, sy = H / dh;
  const depth = new Float32Array(dw * dh), conf = new Uint8Array(dw * dh);
  for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
    let s = 0, n = 0, mn = 1e9, mx = -1e9;
    for (let y = Math.floor(j * sy); y < Math.min(H, Math.floor((j + 1) * sy)); y++) for (let x = Math.floor(i * sx); x < Math.min(W, Math.floor((i + 1) * sx)); x++) { const v = hm[y * W + x]; s += v; n++; mn = Math.min(mn, v); mx = Math.max(mx, v); }
    const hAvg = n ? s / n : 0;
    const u = (i + 0.5) / dw - 0.5, v = (j + 0.5) / dh - 0.5;
    const z = camZmm * (1 + tilt[0] * u + tilt[1] * v) - hAvg;
    const nz = noiseMm * (z / 300) ** 2 * (Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()));
    depth[j * dw + i] = (z + nz) / 1000;
    conf[j * dw + i] = mx - mn > 3 ? 1 : 2; // edges are less certain
  }
  const fx = pxPerMm * camZmm;
  return { data: depth, w: dw, h: dh, conf, fx, fy: fx, cx: W / 2, cy: H / 2 };
}
