// PillCV — pill detection, counting and odd-pill detection.
// Pure JS, no dependencies. Runs in a Web Worker on the phone and in Node for tests.
//
// Pipeline
//  1. RGB -> CIELAB.
//  2. Model the tray/plate as a smooth colour surface (quadratic fit), so uneven
//     lighting, vignetting and colour casts do not look like pills.
//  3. Foreground = colour distance from that surface (with soft-shadow suppression)
//     OR a sharp edge (catches white pills on white plates). Hysteresis + hole fill.
//  4. Connected blobs. Learn the single-pill size from clean, convex blobs.
//  5. Split touching / overlapping blobs: distance-transform cores give one seed
//     per visible pill; area / single-pill area estimates pills hidden by overlap.
//  6. Describe every pill (illumination-normalised colour, two-tone, size, aspect)
//     and group them by type. The biggest group is "primary"; the rest are flagged.

const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

export function linToLab(r, g, b) {
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const lin = [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
  return lin.map((c) => {
    c = Math.max(0, Math.min(1, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  });
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
function mad(arr, med) { return 1.4826 * median(arr.map((v) => Math.abs(v - med))); }
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------- least squares quadratic surface ----------
function solve(A, y, n) {
  // Gaussian elimination with partial pivoting on an n x n system.
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
function quadBasis(u, v) { return [1, u, v, u * u, u * v, v * v]; }
function fitQuad(us, vs, vals, idx) {
  const n = 6, A = Array.from({ length: n }, () => new Float64Array(n)), y = new Float64Array(n);
  for (const i of idx) {
    const B = quadBasis(us[i], vs[i]);
    for (let r = 0; r < n; r++) {
      y[r] += B[r] * vals[i];
      for (let c = r; c < n; c++) A[r][c] += B[r] * B[c];
    }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < r; c++) A[r][c] = A[c][r];
  for (let r = 0; r < n; r++) A[r][r] += 1e-6 * idx.length; // ridge, keeps it stable
  return solve(A.map((r) => Array.from(r)), Array.from(y), n);
}
const evalQuad = (c, u, v) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;

// ---------- binary morphology (square structuring element, separable) ----------
function dilate(src, w, h, r, roi) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    const o = y * w;
    for (let x = 0; x < w; x++) { if (src[o + x]) run = x; if (x - run <= r) tmp[o + x] = 1; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (src[o + x]) run = x; if (run - x <= r) tmp[o + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (y - run <= r) out[y * w + x] = 1; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
  }
  if (roi) for (let i = 0; i < w * h; i++) out[i] &= roi[i];
  return out;
}
function erode(src, w, h, r) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = src[i] ? 0 : 1;
  const d = dilate(inv, w, h, r);
  for (let i = 0; i < w * h; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

function fillHoles(mask, w, h) {
  // Background reachable from the image border stays background; everything else is filled.
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] || !seen[i] ? 1 : 0;
  return out;
}

// ---------- Euclidean distance transform (Felzenszwalb & Huttenlocher) ----------
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
export function distanceTransform(mask, w, h) {
  const INF = 1e10, n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? INF : 0;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

// ---------- connected components ----------
function components(mask, w, h, minArea = 1) {
  const label = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    const id = next++, px = [];
    let sp = 0; stack[sp++] = s; label[s] = id;
    while (sp) {
      const i = stack[--sp]; px.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = id; stack[sp++] = i + w; }
    }
    if (px.length < minArea) { for (const i of px) label[i] = -1; continue; }
    comps.push({ id, px });
  }
  return { label, comps };
}

function shapeStats(px, w) {
  let sx = 0, sy = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (const i of px) {
    const x = i % w, y = (i / w) | 0;
    sx += x; sy += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const n = px.length, cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  const rowL = new Map(), rowR = new Map();
  for (const i of px) {
    const x = i % w, y = (i / w) | 0, dx = x - cx, dy = y - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
    if (!rowL.has(y) || x < rowL.get(y)) rowL.set(y, x);
    if (!rowR.has(y) || x > rowR.get(y)) rowR.set(y, x);
  }
  xx = xx / n + 1 / 12; yy = yy / n + 1 / 12; xy /= n;
  const tr = xx + yy, det = xx * yy - xy * xy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const major = 2 * Math.sqrt(l1), minor = 2 * Math.sqrt(l2); // semi-axes of equivalent ellipse
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  // convex hull from row extremes (pixel corners), monotone chain
  const pts = [];
  for (const [y, xl] of rowL) { const xr = rowR.get(y); pts.push([xl - 0.5, y - 0.5], [xl - 0.5, y + 0.5], [xr + 0.5, y - 0.5], [xr + 0.5, y + 0.5]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let hullArea = 0;
  for (let k = 0; k < hull.length; k++) { const a = hull[k], b = hull[(k + 1) % hull.length]; hullArea += a[0] * b[1] - b[0] * a[1]; }
  hullArea = Math.abs(hullArea) / 2;
  // longest straight run of the outline (a fracture edge on a broken tablet)
  // chain consecutive hull segments that turn by < ~11 degrees (pixel stair-steps)
  let maxEdge = 0;
  if (hull.length > 2) {
    const seg = hull.map((a, k) => { const b = hull[(k + 1) % hull.length]; return [b[0] - a[0], b[1] - a[1]]; });
    const m = seg.length;
    for (let k0 = 0; k0 < m; k0++) {
      let sx = seg[k0][0], sy = seg[k0][1];
      for (let k = 1; k < m; k++) {
        const d = seg[(k0 + k) % m];
        const ang = Math.abs(Math.atan2(sx * d[1] - sy * d[0], sx * d[0] + sy * d[1]));
        if (ang > 0.2) break;
        sx += d[0]; sy += d[1];
      }
      maxEdge = Math.max(maxEdge, Math.hypot(sx, sy));
    }
  }
  return {
    area: n, cx, cy, major, minor, theta, aspect: major / minor,
    solidity: n / Math.max(n, hullArea), fill: n / (Math.PI * major * minor),
    bbox: [minX, minY, maxX, maxY], hull, hullArea, straight: maxEdge / Math.sqrt(n),
  };
}

function fillPolygon(mask, w, h, poly) {
  // convex polygon raster fill
  let y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(h - 1, Math.floor(y1)); y++) {
    let xl = Infinity, xr = -Infinity;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if ((a[1] <= y && b[1] >= y) || (b[1] <= y && a[1] >= y)) {
        const x = a[1] === b[1] ? Math.min(a[0], b[0]) : a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        const x2 = a[1] === b[1] ? Math.max(a[0], b[0]) : x;
        xl = Math.min(xl, x); xr = Math.max(xr, x2);
      }
    }
    for (let x = Math.max(0, Math.ceil(xl)); x <= Math.min(w - 1, Math.floor(xr)); x++) mask[y * w + x] = 1;
  }
}

// ---------- colour naming (SPL colour vocabulary used by FDA labels) ----------
export function colorName(L, a, b) {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI; if (h < 0) h += 360;
  if (C < 9 || (C < 13 && L > 82)) return L > 72 ? "white" : L > 35 ? "gray" : "black";
  if (h >= 15 && h < 70 && L < 52 && C < 45) return "brown";
  if (h < 15 || h >= 340) return L > 62 ? "pink" : "red";
  if (h < 48) return (L > 62 && C < 42) || (L > 70 && C < 50) ? "pink" : "red";
  if (h < 72) return "orange";
  if (h < 112) return "yellow";
  if (h < 185) return "green";
  if (h < 235) return "turquoise";
  if (h < 300) return "blue";
  return L > 60 ? "pink" : "purple";
}
// neighbouring names a camera could plausibly confuse
const COLOR_NEAR = {
  white: ["gray", "yellow", "pink"], gray: ["white", "black"], black: ["gray"],
  yellow: ["orange", "white"], orange: ["yellow", "red", "brown", "pink"], red: ["pink", "orange", "brown"],
  pink: ["red", "orange", "white", "purple"], brown: ["orange", "red"], green: ["turquoise"],
  turquoise: ["green", "blue"], blue: ["turquoise", "purple"], purple: ["blue", "pink"],
};
export function colorSimilarity(seen, label) {
  label = label.toLowerCase();
  if (seen === label) return 1;
  if ((COLOR_NEAR[seen] || []).includes(label)) return 0.45;
  return 0.05;
}

function shapeName(st) {
  if (st.fill < 0.9 && st.aspect < 1.5) return "triangle";
  if (st.aspect < 1.13) return st.fill < 0.965 ? "four-sided" : "round";
  if (st.aspect > 1.85) return "capsule";
  return st.fill < 0.955 && st.aspect < 1.5 ? "four-sided" : "oval";
}

// ---------- main entry ----------
/**
 * @param {Uint8ClampedArray} rgba  image pixels (already downscaled by caller, ~640–1200 px long side)
 * @param {number} w @param {number} h
 * @param {object} opts { roi: {shape:'rect'|'ellipse', x,y,w,h} normalised 0..1, expectedSizeMm, mmPerPx }
 */
export function analyze(rgba, w, h, opts = {}) {
  const t0 = Date.now(), N = w * h;
  const warnings = [];

  // ROI
  const roi = new Uint8Array(N);
  const R = opts.roi || { shape: "rect", x: 0.02, y: 0.02, w: 0.96, h: 0.96 };
  const rx0 = R.x * w, ry0 = R.y * h, rw = R.w * w, rh = R.h * h;
  let roiArea = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let inside;
    if (R.shape === "ellipse") {
      const u = (x + 0.5 - (rx0 + rw / 2)) / (rw / 2), v = (y + 0.5 - (ry0 + rh / 2)) / (rh / 2);
      inside = u * u + v * v <= 1;
    } else inside = x >= rx0 && x < rx0 + rw && y >= ry0 && y < ry0 + rh;
    if (inside) { roi[y * w + x] = 1; roiArea++; }
  }

  // 1. Sensor-noise estimate -> adaptive pre-smoothing -> Lab
  const sensorNoise = estimateNoise(rgba, w, h);
  const blurR = sensorNoise > 5 ? 2 : 1;
  const sm = boxBlurRGB(rgba, w, h, blurR);
  if (sensorNoise > 5) { const sm2 = boxBlurRGBf(sm, w, h, 1); sm.set(sm2); }
  const L = new Float32Array(N), A = new Float32Array(N), B = new Float32Array(N);
  const lin = new Float32Array(3 * N); // smoothed linear RGB, used for the shadow test
  let clipped = 0;
  for (let i = 0; i < N; i++) {
    // inline sRGB->linear (interpolated LUT) and linear->Lab, no allocations
    let v = sm[3 * i], k = v > 254 ? 254 : v | 0;
    const r = SRGB_LIN[k] + (SRGB_LIN[k + 1] - SRGB_LIN[k]) * (v - k);
    v = sm[3 * i + 1]; k = v > 254 ? 254 : v | 0;
    const g = SRGB_LIN[k] + (SRGB_LIN[k + 1] - SRGB_LIN[k]) * (v - k);
    v = sm[3 * i + 2]; k = v > 254 ? 254 : v | 0;
    const b = SRGB_LIN[k] + (SRGB_LIN[k + 1] - SRGB_LIN[k]) * (v - k);
    lin[3 * i] = r; lin[3 * i + 1] = g; lin[3 * i + 2] = b;
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fx = X > 0.008856 ? Math.cbrt(X) : 7.787 * X + 0.137931, fy = Y > 0.008856 ? Math.cbrt(Y) : 7.787 * Y + 0.137931, fz = Z > 0.008856 ? Math.cbrt(Z) : 7.787 * Z + 0.137931;
    L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
    if (roi[i] && rgba[4 * i] > 250 && rgba[4 * i + 1] > 250 && rgba[4 * i + 2] > 250) clipped++;
  }

  // 1b. Tray mode: find the tray/plate (the large uniform surface around the centre)
  // and count only inside it.
  let tray = null;
  if (opts.mode === "tray") {
    tray = detectTray(L, A, B, w, h);
    if (tray) {
      roiArea = 0;
      for (let i = 0; i < N; i++) { roi[i] &= tray.mask[i]; roiArea += roi[i]; }
    }
  }

  // 2. Background surface. Sample grid, weight outer ring (tray edges are rarely covered).
  const step = Math.max(2, Math.round(Math.sqrt(roiArea / 9000)));
  const sIdx = [], us = [], vs = [], sL = [], sA = [], sB = [];
  const hist = new Float32Array(48 * 48);
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = y * w + x;
    if (!roi[i]) continue;
    const u = (2 * x) / w - 1, v = (2 * y) / h - 1;
    const k = sIdx.length;
    sIdx.push(i); us.push(u); vs.push(v); sL.push(L[i]); sA.push(A[i]); sB.push(B[i]);
    const ua = (x - (rx0 + rw / 2)) / (rw / 2), va = (y - (ry0 + rh / 2)) / (rh / 2);
    const wgt = 1 + 2 * clamp(Math.hypot(ua, va) - 0.5, 0, 1);
    const ba = clamp(Math.floor((A[i] + 96) / 4), 0, 47), bb = clamp(Math.floor((B[i] + 96) / 4), 0, 47);
    hist[ba * 48 + bb] += wgt;
    void k;
  }
  let best = 0, bestV = -1;
  for (let a = 1; a < 47; a++) for (let b = 1; b < 47; b++) {
    let s = 0;
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) s += hist[(a + da) * 48 + b + db];
    if (s > bestV) { bestV = s; best = a * 48 + b; }
  }
  const a0 = Math.floor(best / 48) * 4 - 96 + 2, b0 = (best % 48) * 4 - 96 + 2;
  let sel = [];
  for (let k = 0; k < sIdx.length; k++) if (Math.hypot(sA[k] - a0, sB[k] - b0) < 7) sel.push(k);
  const L0 = median(sel.map((k) => sL[k]));
  sel = sel.filter((k) => Math.abs(sL[k] - L0) < 30);
  let cL = [L0, 0, 0, 0, 0, 0], cA = [a0, 0, 0, 0, 0, 0], cB = [b0, 0, 0, 0, 0, 0];
  let sigL = 4, sigC = 3;
  for (let it = 0; it < 4 && sel.length > 30; it++) {
    cL = fitQuad(us, vs, sL, sel); cA = fitQuad(us, vs, sA, sel); cB = fitQuad(us, vs, sB, sel);
    const rL = [], rC = [];
    for (let k = 0; k < sIdx.length; k++) {
      rL.push(sL[k] - evalQuad(cL, us[k], vs[k]));
      rC.push(Math.hypot(sA[k] - evalQuad(cA, us[k], vs[k]), sB[k] - evalQuad(cB, us[k], vs[k])));
    }
    const selRL = sel.map((k) => rL[k]), selRC = sel.map((k) => rC[k]);
    sigL = Math.max(0.8, mad(selRL, median(selRL)));
    sigC = Math.max(0.6, 1.4826 * median(selRC));
    const tolL = clamp(3 * sigL, 3, 18), tolC = clamp(3 * sigC, 2.5, 10);
    sel = [];
    for (let k = 0; k < sIdx.length; k++) if (Math.abs(rL[k]) < tolL && rC[k] < tolC) sel.push(k);
  }
  const bgFrac = sel.length / Math.max(1, sIdx.length);
  // background in linear RGB too (shadows keep the tray's chromaticity, only dimmer)
  const cLin = [0, 1, 2].map((c) => (sel.length > 30 ? fitQuad(us, vs, sIdx.map((i) => lin[3 * i + c]), sel) : [median(sIdx.map((i) => lin[3 * i + c])), 0, 0, 0, 0, 0]));

  // per-pixel background (quadratic surfaces evaluated row by row: q(u) = r0 + r1*u + c3*u^2)
  const rowQ = (c, v) => [c[0] + c[2] * v + c[5] * v * v, c[1] + c[4] * v, c[3]];
  const Lb = new Float32Array(N), Ab = new Float32Array(N), Bb = new Float32Array(N);
  const Rb = new Float32Array(N), Gb = new Float32Array(N), Bl = new Float32Array(N);
  let LrefSum = 0;
  for (let y = 0; y < h; y++) {
    const v = (2 * y) / h - 1;
    const qL = rowQ(cL, v), qA = rowQ(cA, v), qB = rowQ(cB, v), q0 = rowQ(cLin[0], v), q1 = rowQ(cLin[1], v), q2 = rowQ(cLin[2], v);
    for (let x = 0; x < w; x++) {
      const u = (2 * x) / w - 1, uu = u * u, i = y * w + x;
      const lb = qL[0] + qL[1] * u + qL[2] * uu;
      Lb[i] = lb > 2 ? lb : 2; Ab[i] = qA[0] + qA[1] * u + qA[2] * uu; Bb[i] = qB[0] + qB[1] * u + qB[2] * uu;
      Rb[i] = Math.max(1e-4, q0[0] + q0[1] * u + q0[2] * uu); Gb[i] = Math.max(1e-4, q1[0] + q1[1] * u + q1[2] * uu); Bl[i] = Math.max(1e-4, q2[0] + q2[1] * u + q2[2] * uu);
      if (roi[i]) LrefSum += Lb[i];
    }
  }
  const Lref = LrefSum / Math.max(1, roiArea);
  if (Lref < 22) warnings.push("dark");
  if (clipped / Math.max(1, roiArea) > 0.04) warnings.push("glare");

  // 3. Foreground score
  const D = new Float32Array(N), shadow = new Uint8Array(N), Ln = new Float32Array(N);
  const chromTol = clamp(0.012 + 0.004 * sensorNoise, 0.014, 0.05);
  for (let i = 0; i < N; i++) {
    const ratio = L[i] / Lb[i];
    Ln[i] = ratio * Lref;
    if (!roi[i]) continue;
    let dL = (ratio - 1) * Lref;
    const da = A[i] - Ab[i], db = B[i] - Bb[i], dc = Math.sqrt(da * da + db * db);
    // shadow test in linear RGB: same chromaticity as the tray, 15–93% of its brightness
    const br = Rb[i], bgc = Gb[i], bb = Bl[i];
    const pr = lin[3 * i], pg = lin[3 * i + 1], pb = lin[3 * i + 2];
    const sb = br + bgc + bb, sp = pr + pg + pb + 1e-5;
    const I = sp / sb;
    if (I < 0.93 && I > 0.15) {
      const chrom = Math.abs(pr / sp - br / sb) + Math.abs(pg / sp - bgc / sb) + Math.abs(pb / sp - bb / sb);
      if (chrom < chromTol * (1 + 0.6 * (1 - I))) { shadow[i] = I < 0.75 ? 2 : 1; dL *= 0.12; }
    }
    const dcs = shadow[i] ? dc * 0.3 : dc;
    D[i] = Math.sqrt(0.5625 * dL * dL + dcs * dcs);
  }
  // edge strength on illumination-normalised L, 3x3 box smoothed (separable)
  const Lh = new Float32Array(N), Ls = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; Lh[i] = Ln[i - 1] + Ln[i] + Ln[i + 1]; }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; Ls[i] = (Lh[i - w] + Lh[i] + Lh[i + w]) / 9; }
  const G = new Float32Array(N);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    const gx = Ls[i - w + 1] + 2 * Ls[i + 1] + Ls[i + w + 1] - Ls[i - w - 1] - 2 * Ls[i - 1] - Ls[i + w - 1];
    const gy = Ls[i + w - 1] + 2 * Ls[i + w] + Ls[i + w + 1] - Ls[i - w - 1] - 2 * Ls[i - w] - Ls[i - w + 1];
    G[i] = Math.sqrt(gx * gx + gy * gy) / 8;
  }
  const bgD = sel.map((k) => D[sIdx[k]]), bgG = sel.map((k) => G[sIdx[k]]);
  const noiseD = Math.max(0.5, 1.4826 * median(bgD)), noiseG = Math.max(0.08, 1.4826 * median(bgG));
  const Td = clamp(3.5 * noiseD + 4, 6, 20), Tg = clamp(6 * noiseG + 1, 2.2, 14); // floor: JPEG/denoised video hides sensor noise, block edges must not count
  if (noiseD > 4) warnings.push("noisy");

  const strong = new Uint8Array(N), weak = new Uint8Array(N);
  const deep = new Uint8Array(N); for (let i = 0; i < N; i++) deep[i] = shadow[i] === 2 ? 1 : 0;
  const nearShadow = dilate(deep, w, h, 2);
  for (let i = 0; i < N; i++) {
    if (!roi[i]) continue;
    const g = nearShadow[i] && G[i] < 2.5 * Tg ? 0 : G[i]; // a cast shadow's outline is not a pill edge
    if (D[i] > Td || g > Tg) strong[i] = 1;
    if (D[i] > 0.55 * Td || g > 0.6 * Tg) weak[i] = 1;
  }
  // hysteresis: keep weak pixels connected to strong ones
  let fg = new Uint8Array(N);
  {
    const stack = new Int32Array(N); let sp = 0;
    for (let i = 0; i < N; i++) if (strong[i]) { fg[i] = 1; stack[sp++] = i; }
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && weak[j] && !fg[j]) { fg[j] = 1; stack[sp++] = j; }
    }
  }
  fg = erode(dilate(fg, w, h, 1, roi), w, h, 1); // close small gaps in edge rings
  fg = fillHoles(fg, w, h);
  // Low-contrast pills (white on white) show only as an open edge ring: fill ring-like
  // shapes to their convex hull.
  for (const c of components(fg, w, h, 6).comps) {
    const st = shapeStats(c.px, w);
    if (st.solidity < 0.6 && st.hullArea < 0.03 * roiArea && st.hullArea > 40 && st.major / st.minor < 3) {
      fillPolygon(fg, w, h, st.hull);
    }
  }
  fg = dilate(erode(fg, w, h, 1), w, h, 1, roi); // open: drop specks and thin edge noise

  // Glare / light pools: big blobs with soft outlines. Inside them keep only what has
  // real edges (pills sitting in the glare), drop the glow itself.
  {
    const first = components(fg, w, h, 6).comps;
    const sharpAreas = [], edges = [];
    for (const c of first) {
      const bd = [];
      let lr = 0, eg = 0;
      for (const i of c.px) { lr += L[i] / Lb[i]; if (G[i] > Tg) eg++; if (!fg[i - 1] || !fg[i + 1] || !fg[i - w] || !fg[i + w]) bd.push(G[i]); }
      c.edge = median(bd); c.bright = lr / c.px.length; c.edgeFrac = eg / c.px.length;
      edges.push(c.edge);
      if (c.edge >= 0.5 * Tg) sharpAreas.push(c.px.length);
    }
    const typical = median(sharpAreas.length >= 3 ? sharpAreas : first.map((c) => c.px.length).filter((a) => a >= 20)) || 1e9, typEdge = median(edges);
    for (const c of first) {
      // glare = big, brighter than the tray, and with an outline far softer than the pills'
      const softOutline = c.edge < 0.5 * Tg && c.edge < 0.35 * typEdge;
      const flatInside = c.edgeFrac < 0.12 && c.px.length > 6 * typical; // a pile of pills is full of rims
      if (!(softOutline || flatInside) || c.bright < 1.03 || c.px.length < 3 * typical) continue;
      warnings.push("glare");
      const sub = new Uint8Array(N);
      for (const i of c.px) { fg[i] = 0; if (G[i] > 0.8 * Tg && !nearShadow[i]) sub[i] = 1; }
      let m = erode(dilate(sub, w, h, 1), w, h, 1);
      m = fillHoles(m, w, h);
      m = dilate(erode(m, w, h, 1), w, h, 1);
      for (const i of c.px) if (m[i]) fg[i] = 1;
    }
  }

  const debug = opts.debug ? { D, G, fg, label: null } : null;
  // 4. Components
  const { label, comps } = components(fg, w, h, 6);
  if (debug) debug.label = label;
  const dt = distanceTransform(fg, w, h);
  for (const c of comps) {
    Object.assign(c, shapeStats(c.px, w));
    let m = 0; for (const i of c.px) if (dt[i] > m) m = dt[i];
    c.maxDT = m;
    let ds = 0; for (const i of c.px) ds += D[i];
    c.meanD = ds / c.px.length;
    c.touchesRoi = false;
    for (const i of c.px) {
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !roi[i - 1] || !roi[i + 1] || !roi[i - w] || !roi[i + w]) { c.touchesRoi = true; break; }
    }
  }
  // drop huge structures (table edge, hand, plate rim)
  // A surface covering a big part of the frame (tray on a table, seen in "anywhere" mode):
  // rerun inside that surface.
  if (opts.mode !== "tray" && !opts._retry && comps.some((c) => c.area >= 0.3 * roiArea)) {
    const r2 = analyze(rgba, w, h, { ...opts, mode: "tray", _retry: true });
    if (r2.tray) return r2;
  }
  // a pill is never smaller than ~1/8000 of the counting area (a 6 mm tablet on a 200 mm tray is ~1/900)
  const minPill = Math.max(12, roiArea / 8000);
  let blobs = comps.filter((c) => c.area < 0.3 * roiArea && c.area >= minPill);

  // single-pill unit size: the most common size among clean convex blobs.
  // Score each candidate size by how many blobs share it (+-22%), mildly favouring
  // larger sizes so sensor specks never win.
  const clean = blobs.filter((c) => c.solidity > 0.9 && c.fill > 0.82 && c.fill < 1.1 && !c.touchesRoi && c.area >= 20);
  let pool = clean.length >= 2 ? clean : blobs.filter((c) => c.area >= 20);
  // broken pieces never define the pill size: drop blobs with an unusually long straight edge
  const straightRef = median(pool.map((c) => c.straight));
  const whole = pool.filter((c) => c.straight < 1.35 * straightRef);
  if (whole.length >= 2) pool = whole;
  let unit = 1;
  if (pool.length) {
    // find size modes
    const modes = [];
    for (const c of [...pool].sort((a, b) => a.area - b.area)) {
      const near = pool.filter((d) => Math.abs(Math.log(d.area / c.area)) < 0.2);
      const m = { area: median(near.map((d) => d.area)), support: near.length };
      if (!modes.some((o) => Math.abs(Math.log(o.area / m.area)) < 0.15)) modes.push(m);
    }
    // the pill size is the mode covering the most area: specks and JPEG artefacts are numerous but tiny
    let pick = modes.reduce((a, b) => (b.support * b.area > a.support * a.area ? b : a), modes[0]);
    // if a well-supported mode sits at ~1/2..2/3 of it, the picked mode is overlapping pairs
    for (let guard = 0; guard < 3; guard++) {
      const smaller = modes.filter((m) => m.area > 0.38 * pick.area && m.area < 0.7 * pick.area && m.support >= Math.max(3, 0.5 * pick.support));
      if (!smaller.length) break;
      pick = smaller.reduce((a, b) => (b.support > a.support ? b : a));
    }
    unit = pick.area;
    for (let it = 0; it < 3; it++) {
      const s = pool.filter((c) => c.area / unit > 0.7 && c.area / unit < 1.35);
      if (!s.length) break;
      unit = median(s.map((c) => c.area));
    }
  }
  const singlesRef = pool.filter((c) => c.area / unit > 0.7 && c.area / unit < 1.35);
  const rUnit = median(singlesRef.map((c) => c.maxDT)) || Math.sqrt(unit / Math.PI);
  const aspUnit = median(singlesRef.map((c) => c.aspect)) || 1;
  // interior-edge cuts are unsafe when single pills have strong internal edges (two-tone capsules)
  // A cut edge must be stronger than the edges single pills normally show inside
  // (bevels, score lines, imprint, two-tone seams).
  const peakInner = singlesRef.map((c) => {
    const g = []; for (const i of c.px) if (dt[i] >= Math.max(2.5, 0.4 * rUnit)) g.push(G[i]);
    g.sort((a, b) => a - b); return g.length ? g[Math.floor(g.length * 0.98)] : 0;
  });
  const cutT = Math.max(1.5 * Tg, 1.15 * median(peakInner));
  const cutsOk = singlesRef.length >= 2;

  // Learn the single-pill silhouette from the most typical clean single.
  let tpl = null;
  {
    let best = null, bs = Infinity;
    for (const c of singlesRef) {
      if (c.touchesRoi) continue;
      const sc = Math.abs(Math.log(c.area / unit)) + 2 * (1 - c.solidity) + 0.5 * Math.abs(c.aspect - aspUnit);
      if (sc < bs) { bs = sc; best = c; }
    }
    if (best && singlesRef.length >= 2 && !opts.fast) tpl = buildTemplate(best, w);
  }

  // 5. Split / estimate per blob
  const pills = [], fragments = [], blobOut = [];
  for (const c of blobs) {
    const nArea = c.area / unit;
    if (nArea < 0.22) continue; // crumbs / dust
    const singleShape = c.solidity > 0.92 && c.fill > 0.84 && Math.abs(c.aspect - aspUnit) < Math.max(0.22, 0.2 * aspUnit);
    let n = 1, conf = "high", seeds = null, small = false, fitParts = null;
    if (nArea < 0.78) {
      // smaller than a pill: a broken piece, or a different (smaller) pill. Decided after colour grouping.
      if (c.solidity < 0.8) continue;
      small = true;
    } else if (nArea >= 1.38 && nArea < 2 && c.solidity > 0.95 && c.fill > 0.93 && Math.abs(c.aspect - aspUnit) < 0.12) {
      n = 1; conf = "medium"; // one bigger pill of the same shape (a different strength/drug), not two
    } else if (nArea < 1.38 && singleShape) {
      n = 1;
    } else if (nArea < 1.5 && c.solidity > 0.94 && c.fill > 0.9 && Math.abs(c.aspect - aspUnit) < Math.max(0.2, 0.15 * aspUnit)) {
      n = 1; conf = "medium"; // convex but off-size: a different pill, or a heavy overlap
    } else {
      // seed cores from the distance transform at several depths
      let bestCores = null;
      for (const t of [0.35, 0.45, 0.55, 0.65, 0.75]) {
        const thr = t * rUnit, sub = [];
        for (const i of c.px) if (dt[i] > thr) sub.push(i);
        const cores = coreComponents(sub, w, Math.max(2, 0.12 * (1 - t) * (1 - t) * unit));
        if (!bestCores || cores.length > bestCores.length) bestCores = cores;
      }
      // Overlaps hide the neck between pills, but the top pill's rim still shows as an
      // edge inside the blob. Cut along interior edges and count cores again.
      if (cutsOk) {
        const cutPx = c.px.filter((i) => !(G[i] > cutT && dt[i] >= Math.max(2.5, 0.4 * rUnit)));
        const cdt = localDT(cutPx, w);
        for (const t of [0.4, 0.5, 0.6]) {
          const sub = cutPx.filter((i) => cdt.get(i) > t * rUnit);
          const cores = coreComponents(sub, w, Math.max(3, 0.2 * (1 - t) * (1 - t) * unit));
          if (cores.length > bestCores.length && cores.length <= Math.round(nArea * 1.5)) bestCores = cores;
        }
      }
      const nMark = bestCores ? bestCores.length : 1;
      const nRound = Math.max(1, Math.round(nArea));
      const upper = Math.max(nRound, Math.ceil(nArea * 1.55));
      const clean2 = nMark === nRound && Math.abs(nArea - nRound) < 0.2;
      if (tpl && !clean2) {
        // Fit copies of the learned single-pill silhouette into the clump.
        const fit = fitPills(c, tpl, dt, G, Tg, w, h, upper, opts);
        n = clamp(fit.placements.length, 1, upper);
        // compact clumps (solidity > 0.86) are usually overlaps, where the visible-area model
        // beats silhouette fitting (measured on the synthetic benchmark)
        if (c.solidity > 0.86) {
          const nOv = nMark < nArea - 0.35 ? Math.max(nMark, Math.round(nArea / (nArea < 1.9 ? 0.8 : 0.72))) : Math.max(nMark, nRound);
          if (nOv !== n) { n = clamp(nOv, 1, upper); fitParts = null; }
        }
        if (n === 1 && nArea >= 1.3) n = 2;
        const agree = (n === nMark) + (n === nRound);
        conf = fit.residual > 0.15 * nArea ? "low" : agree >= 1 ? "high" : "medium";
        if (nArea > 5 && agree === 0) conf = "low";
        fitParts = n === fit.parts.length ? fit.parts : null;
        c.diag = { nMark, nFit: fit.placements.length, residual: fit.residual };
      } else if (clean2) {
        n = nRound; conf = "high";
      } else {
        const overlapped = nMark < nArea - 0.35;
        const nOverlap = Math.round(nArea / (nArea < 1.9 ? 0.8 : 0.72));
        n = clamp(Math.max(nMark, overlapped ? nOverlap : nRound), 1, upper);
        if (n === 1 && nArea >= 1.15) n = 2;
        conf = nMark === n ? "high" : Math.abs(nMark - n) === 1 ? "medium" : "low";
      }
      seeds = bestCores && bestCores.length ? bestCores.slice(0, n) : null;
    }
    let parts = n === 1 ? [c.px] : fitParts || partition(c, n, seeds, w);
    // over-split guard: every part of a split must be pill-sized
    while (!fitParts && n > 1 && n > Math.round(nArea) && parts.some((q) => q.length < 0.42 * unit)) {
      n--; seeds = seeds ? seeds.slice(0, n) : null;
      parts = n === 1 ? [c.px] : partition(c, n, seeds, w);
      conf = "medium";
    }
    const blobPills = [];
    for (const p of parts) {
      const st = n === 1 ? c : shapeStats(p, w);
      const pill = { x: st.cx, y: st.cy, a: st.major, b: st.minor, theta: st.theta, blob: c.id, inCluster: n > 1, px: p, small, frac: nArea, straight: c.straight };
      blobPills.push(pill); pills.push(pill);
    }
    blobOut.push({ id: c.id, n: parts.length, conf, nArea, bbox: c.bbox, solidity: c.solidity, straight: c.straight, diag: c.diag });
    for (const p of blobPills) p.conf = conf;
    void label;
  }

  // 6. Describe each pill: illumination-normalised colour, two-tone, size, aspect
  // white balance from the tray if it is near neutral
  let wbR = 1, wbG = 1, wbB = 1;
  {
    let r = 0, g = 0, b = 0;
    for (const k of sel) { const i = sIdx[k]; r += SRGB_LIN[rgba[4 * i]]; g += SRGB_LIN[rgba[4 * i + 1]]; b += SRGB_LIN[rgba[4 * i + 2]]; }
    const bgC = Math.hypot(cA[0], cB[0]);
    if (sel.length && bgC < 12) { const m = (r + g + b) / 3; wbR = m / r; wbG = m / g; wbB = m / b; }
  }
  const Yref = Math.pow((Lref + 16) / 116, 3);
  for (const p of pills) {
    const st = p.inCluster ? null : blobs.find((c) => c.id === p.blob);
    const inner = p.px.filter((i) => dt[i] >= Math.max(1.5, 0.35 * rUnit));
    const use = inner.length >= 6 ? inner : p.px;
    const meanLab = (list) => {
      let r = 0, g = 0, b = 0, f = 0;
      for (const i of list) {
        const Yb = Math.pow((Lb[i] + 16) / 116, 3), k = Yref / Yb; // undo lighting falloff
        r += SRGB_LIN[rgba[4 * i]] * k; g += SRGB_LIN[rgba[4 * i + 1]] * k; b += SRGB_LIN[rgba[4 * i + 2]] * k; f++;
      }
      return linToLab((wbR * r) / f, (wbG * g) / f, (wbB * b) / f);
    };
    p.lab = meanLab(use);
    // two-tone: compare the two halves along the long axis
    const ct = Math.cos(p.theta), sn = Math.sin(p.theta);
    const h1 = [], h2 = [];
    for (const i of use) { const x = i % w, y = (i / w) | 0, s = (x - p.x) * ct + (y - p.y) * sn; if (s > 0.15 * p.a) h1.push(i); else if (s < -0.15 * p.a) h2.push(i); }
    p.halves = h1.length > 4 && h2.length > 4 ? [meanLab(h1), meanLab(h2)] : [p.lab, p.lab];
    p.twoTone = deltaE(p.halves[0], p.halves[1]);
    p.area = p.inCluster ? null : p.px.length;
    p.aspect = st ? st.aspect : null;
    p.shape = st ? shapeName(st) : null;
    p.lengthPx = st ? 2 * st.major * 1.0 : null;
    p.color = colorName(...p.lab);
    delete p.px;
  }

  // 7. Group by type. Small pieces matching the main pill's colour are broken pieces, not pills.
  {
    const whole = pills.filter((p) => !p.small);
    const ref = whole.length ? describe(whole, unit) : null;
    for (let k = pills.length - 1; k >= 0; k--) {
      const p = pills[k];
      if (!p.small) continue;
      // broken piece = main pill's colour AND a fracture signature: an unusually long straight
      // edge (round/oval tablets) or a stub much shorter than the whole pill (capsule shapes).
      const fracture = aspUnit > 1.6 ? (p.b > 0 && p.a / p.b < 0.75 * aspUnit) : p.straight > 1.35 * straightRef;
      const dC = ref ? Math.min(deltaE(p.lab, ref.lab), deltaE(p.lab, ref.halves[0]), deltaE(p.lab, ref.halves[1])) : 0;
      if (!ref || (dC < ref.tolC && fracture)) {
        fragments.push({ x: p.x, y: p.y, a: p.a, b: p.b, theta: p.theta, frac: p.frac, blob: p.blob });
        const bo = blobOut.find((b) => b.id === p.blob); if (bo) { bo.n = 0; bo.conf = "fragment"; }
        pills.splice(k, 1);
      }
    }
  }
  const groups = groupPills(pills, unit);
  groups.sort((a, b) => b.count - a.count);
  const primary = groups[0] || null;
  groups.forEach((g, k) => { g.index = k; for (const p of g.pills) p.group = k; });
  // A smooth convex blob split into pieces that are all "not the main pill" is one bigger,
  // different pill, not two main ones.
  for (const bo of blobOut) {
    if (bo.n < 2 || !(bo.solidity > 0.94) || bo.nArea > 2.2) continue;
    const mine = pills.filter((p) => p.blob === bo.id);
    if (!mine.length || mine.some((p) => p.group === 0) || new Set(mine.map((p) => p.group)).size > 1) continue;
    const c = blobs.find((b) => b.id === bo.id), keep = mine[0];
    Object.assign(keep, { x: c.cx, y: c.cy, a: c.major, b: c.minor, theta: c.theta, inCluster: false, conf: "medium" });
    for (const p of mine.slice(1)) { pills.splice(pills.indexOf(p), 1); const g = groups[p.group]; g.pills.splice(g.pills.indexOf(p), 1); g.count--; }
    bo.n = 1; bo.conf = "medium";
  }
  groups.forEach((g, k) => { g.role = k === 0 ? "primary" : g.count <= Math.max(2, 0.2 * (primary ? primary.count : 0)) ? "odd" : "mixed"; });

  // contrast check
  if (primary && primary.lab) {
    const contrast = Math.hypot(0.75 * (primary.lab[0] - Lref), primary.lab[1] - cA[0], primary.lab[2] - cB[0]);
    if (contrast < 9) warnings.push("low-contrast");
  }
  if (blobOut.some((b) => b.conf === "low")) warnings.push("pile");

  const total = pills.length;
  // white pills on a light neutral surface: edges only, unreliable
  const bgLight = Lref > 62 && Math.hypot(cA[0], cB[0]) < 12;
  if (bgLight && (!primary || colorName(...primary.lab) === "white" || colorName(...primary.lab) === "gray")) {
    const edgeFrac = (() => { let k = 0, n = 0; for (let i = 0; i < N; i += 7) if (roi[i]) { n++; if (G[i] > Tg) k++; } return n ? k / n : 0; })();
    if (!primary || edgeFrac > 0.01 || warnings.includes("low-contrast")) warnings.push("white-on-white");
  }
  let lo = 0, hi = 0;
  for (const b of blobOut) {
    if (!b.n) continue;
    // stacked pills can hide up to ~half of themselves: the honest upper bound is wide
    if (b.conf === "low") { lo += Math.max(b.n - 1, Math.round(b.nArea * 0.9), 1); hi += Math.max(b.n + 1, Math.ceil(b.nArea / 0.5)); }
    else if (b.conf === "medium") { lo += Math.max(1, b.n - 1); hi += b.n + 1; }
    else { lo += b.n; hi += b.n; }
  }
  lo = Math.min(lo, total); hi = Math.max(hi, total);

  // Overall confidence 0..1: per-pill certainty x image quality.
  const wConf = { high: 1, medium: 0.8, low: 0.5 };
  let cs = 0;
  for (const p of pills) cs += wConf[p.conf] ?? 0.7;
  let confidence = total ? cs / total : (warnings.length ? 0.3 : 0.9);
  const pen = { dark: 0.85, noisy: 0.85, glare: 0.92, "low-contrast": 0.6, "white-on-white": 0.3, pile: 0.9 };
  for (const wv of new Set(warnings)) confidence *= pen[wv] ?? 1;
  if (fragments.length) confidence *= 0.95;
  confidence = clamp(confidence, 0, 1);

  const mmPerPx = opts.mmPerPx || null;
  return {
    width: w, height: h, total, range: [lo, hi], confidence, unitArea: unit, rUnit,
    tray: tray ? { shape: "poly", x: tray.x, y: tray.y, w: tray.w, h: tray.h, poly: tray.poly } : null,
    pills: pills.map((p) => ({ x: p.x, y: p.y, a: p.a, b: p.b, theta: p.theta, group: p.group, conf: p.conf, color: p.color, lab: p.lab, inCluster: p.inCluster, blob: p.blob })),
    fragments, blobs: blobOut,
    groups: groups.map((g) => summarizeGroup(g, mmPerPx)),
    background: { lab: [Lref, cA[0], cB[0]], name: colorName(Lref, cA[0], cB[0]), coverage: bgFrac },
    noise: { d: noiseD, g: noiseG, Td, Tg, sensor: sensorNoise }, warnings: [...new Set(warnings)], debug, ms: Date.now() - t0,
  };
}

function estimateNoise(rgba, w, h) {
  // robust sigma of (pixel - mean of 4 neighbours) on the green channel
  const r = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
  for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
    const i = y * w + x;
    const v = rgba[4 * i + 1] - 0.25 * (rgba[4 * (i - 1) + 1] + rgba[4 * (i + 1) + 1] + rgba[4 * (i - w) + 1] + rgba[4 * (i + w) + 1]);
    r.push(Math.abs(v));
  }
  return (1.4826 * median(r)) / 1.118;
}
function boxBlurRGB(rgba, w, h, rad) {
  const f = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { f[3 * i] = rgba[4 * i]; f[3 * i + 1] = rgba[4 * i + 1]; f[3 * i + 2] = rgba[4 * i + 2]; }
  return boxBlurRGBf(f, w, h, rad);
}
function boxBlurRGBf(f, w, h, rad) {
  const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
  for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0;
    for (let x = -rad; x < w + rad; x++) {
      if (x + rad < w) { s += f[3 * (y * w + x + rad) + c]; n++; }
      if (x - rad - 1 >= 0) { s -= f[3 * (y * w + x - rad - 1) + c]; n--; }
      if (x >= 0 && x < w) tmp[3 * (y * w + x) + c] = s / n;
    }
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0;
    for (let y = -rad; y < h + rad; y++) {
      if (y + rad < h) { s += tmp[3 * ((y + rad) * w + x) + c]; n++; }
      if (y - rad - 1 >= 0) { s -= tmp[3 * ((y - rad - 1) * w + x) + c]; n--; }
      if (y >= 0 && y < h) out[3 * (y * w + x) + c] = s / n;
    }
  }
  return out;
}

// ---------- silhouette template fitting ----------
function buildTemplate(c, w) {
  const set = new Set(c.px);
  const R = Math.ceil(c.major * 1.25) + 2, size = 2 * R + 1;
  const grid = new Uint8Array(size * size);
  const ct = Math.cos(c.theta), st = Math.sin(c.theta);
  let area = 0;
  for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
    // canonical frame (u along the long axis) -> image
    const x = Math.round(c.cx + u * ct - v * st), y = Math.round(c.cy + u * st + v * ct);
    if (set.has(y * w + x)) { grid[(v + R) * size + u + R] = 1; area++; }
  }
  const round = c.aspect < 1.08;
  const nA = round ? 1 : c.aspect > 1.8 ? 18 : 10; // long pills need finer rotation steps
  const angles = Array.from({ length: nA }, (_, k) => (k * Math.PI) / nA);
  const at = (u, v) => (u >= -R && u <= R && v >= -R && v <= R ? grid[(v + R) * size + u + R] : 0);
  const rots = angles.map((a) => {
    const ca = Math.cos(a), sa = Math.sin(a), pts = [], edge = [];
    for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
      if (!at(u, v)) continue;
      const isEdge = !at(u - 1, v) || !at(u + 1, v) || !at(u, v - 1) || !at(u, v + 1);
      const dx = Math.round(u * ca - v * sa), dy = Math.round(u * sa + v * ca);
      if (isEdge && ((u + v) & 1) === 0) edge.push(dx, dy);
      if ((u & 1) === 0 && (v & 1) === 0) pts.push(dx, dy); // quarter-sampled for speed
    }
    // cap the work per placement test: ~140 interior and ~60 outline samples
    const thin = (arr, maxPairs) => { const n = arr.length / 2; if (n <= maxPairs) return arr; const out = []; const st = n / maxPairs; for (let k = 0; k < maxPairs; k++) { const j = Math.floor(k * st) * 2; out.push(arr[j], arr[j + 1]); } return out; };
    return { a, pts: thin(pts, 140), edge: thin(edge, 60) };
  });
  const contains = (dx, dy, a) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    return at(Math.round(dx * ca + dy * sa), Math.round(-dx * sa + dy * ca)) === 1;
  };
  return { R, area, rots, contains, minor: c.minor, long: c.aspect > 1.8 };
}

// Greedy placement of the template: each step adds the copy that explains the most
// still-unexplained blob pixels, penalises spilling outside the blob, and rewards
// outlines that sit on real image edges (rims of overlapping pills).
function fitPills(c, tpl, dt, G, Tg, w, h, maxN, P0 = {}) {
  const minGain = P0.fitMinGain ?? (tpl.long ? 0.42 : 0.3), edgeW = P0.fitEdgeW ?? 0.25;
  const [x0, y0, x1, y1] = c.bbox, m = tpl.R + 2;
  const bx0 = Math.max(0, x0 - m), by0 = Math.max(0, y0 - m), bx1 = Math.min(w - 1, x1 + m), by1 = Math.min(h - 1, y1 + m);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const inB = new Uint8Array(bw * bh), allow = new Uint8Array(bw * bh), cov = new Uint8Array(bw * bh), edgeOk = new Uint8Array(bw * bh);
  for (const i of c.px) inB[(((i / w) | 0) - by0) * bw + (i % w) - bx0] = 1;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const k = y * bw + x;
    let a = 0, e = 0, out = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= bw || Y >= bh) { out = 1; continue; }
      if (inB[Y * bw + X]) a = 1; else out = 1;
      if (G[(Y + by0) * w + X + bx0] > Tg) e = 1;
    }
    allow[k] = a;
    edgeOk[k] = e || (a && out) ? 1 : 0; // real edge, or the blob outline, nearby
  }
  const cands = [];
  for (const i of c.px) {
    const x = i % w, y = (i / w) | 0;
    if (x % 3 || y % 3) continue;
    if (dt[i] >= 0.45 * tpl.minor) cands.push(x - bx0, y - by0);
  }
  if (!cands.length) for (const i of c.px) cands.push((i % w) - bx0, ((i / w) | 0) - by0);
  // at most ~60 candidate centres per pill-sized area of the clump
  const maxC = Math.max(80, Math.round((60 * c.px.length) / tpl.area));
  if (cands.length / 2 > maxC) { const st = cands.length / 2 / maxC, out = []; for (let k = 0; k < maxC; k++) { const j = Math.floor(k * st) * 2; out.push(cands[j], cands[j + 1]); } cands.length = 0; cands.push(...out); }
  const placements = [];
  let uncovered = c.px.length;
  while (placements.length < maxN && uncovered > 0.12 * tpl.area) {
    let best = -Infinity, bx = 0, by = 0, br = null;
    for (let k = 0; k < cands.length; k += 2) {
      const cx = cands[k], cy = cands[k + 1];
      for (const r of tpl.rots) {
        let gain = 0;
        const P = r.pts;
        for (let j = 0; j < P.length; j += 2) {
          const X = cx + P[j], Y = cy + P[j + 1];
          if (X < 0 || Y < 0 || X >= bw || Y >= bh) { gain -= 2; continue; }
          const q = Y * bw + X;
          if (inB[q]) { if (!cov[q]) gain += 1; } else if (!allow[q]) gain -= 2;
        }
        gain *= tpl.area / Math.max(1, P.length / 2); // in full-template pixels
        let eh = 0;
        const E = r.edge;
        for (let j = 0; j < E.length; j += 2) {
          const X = cx + E[j], Y = cy + E[j + 1];
          if (X >= 0 && Y >= 0 && X < bw && Y < bh && edgeOk[Y * bw + X]) eh++;
        }
        gain += edgeW * tpl.area * (eh / Math.max(1, E.length / 2) - 0.5);
        if (gain > best) { best = gain; bx = cx; by = cy; br = r; }
      }
    }
    if (!br || best < minGain * tpl.area) break;
    placements.push({ x: bx, y: by, a: br.a });
    const R = tpl.R;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const X = bx + dx, Y = by + dy;
      if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
      const q = Y * bw + X;
      if (inB[q] && !cov[q] && tpl.contains(dx, dy, br.a)) { cov[q] = 1; uncovered--; }
    }
  }
  // each blob pixel goes to a placement that contains it (else the nearest one)
  const parts = placements.map(() => []);
  if (placements.length) for (const i of c.px) {
    const x = (i % w) - bx0, y = ((i / w) | 0) - by0;
    let bj = 0, bd = Infinity;
    for (let j = 0; j < placements.length; j++) {
      const p = placements[j];
      const d = (x - p.x) ** 2 + (y - p.y) ** 2 + (tpl.contains(x - p.x, y - p.y, p.a) ? 0 : 1e6);
      if (d < bd) { bd = d; bj = j; }
    }
    parts[bj].push(i);
  }
  return { placements: placements.map((p) => ({ x: p.x + bx0, y: p.y + by0, a: p.a })), parts: parts.filter((q) => q.length), residual: uncovered / tpl.area };
}

function detectTray(L, A, B, w, h) {
  // dominant colour among central samples
  const hist = new Map();
  const pts = [];
  for (let y = Math.floor(h * 0.15); y < h * 0.85; y += 4) for (let x = Math.floor(w * 0.15); x < w * 0.85; x += 4) {
    const i = y * w + x;
    const key = (Math.round(L[i] / 8) << 16) | ((Math.round(A[i] / 6) + 64) << 8) | (Math.round(B[i] / 6) + 64);
    hist.set(key, (hist.get(key) || 0) + 1);
    pts.push(i);
  }
  let bestK = 0, bestV = -1;
  for (const [k, v] of hist) if (v > bestV) { bestV = v; bestK = k; }
  const sel = pts.filter((i) => ((Math.round(L[i] / 8) << 16) | ((Math.round(A[i] / 6) + 64) << 8) | (Math.round(B[i] / 6) + 64)) === bestK);
  const L0 = median(sel.map((i) => L[i])), A0 = median(sel.map((i) => A[i])), B0 = median(sel.map((i) => B[i]));
  // surface pixels: same chroma, brightness within a broad band (lighting falloff)
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (Math.hypot(A[i] - A0, B[i] - B0) < 9 && L[i] > L0 * 0.55 && L[i] < L0 * 1.35 + 6) m[i] = 1;
  const { comps } = components(erode(m, w, h, 2), w, h, 50);
  if (!comps.length) return null;
  comps.sort((a, b) => b.px.length - a.px.length);
  const top = comps[0];
  if (top.px.length < 0.08 * w * h) return null;
  // the tray = convex hull of that surface (pills on it are inside the hull)
  const st = shapeStats(top.px, w);
  if (st.hullArea > 0.97 * w * h) return null; // surface fills the frame: nothing to crop
  const mask = new Uint8Array(w * h);
  fillPolygon(mask, w, h, st.hull);
  const [x0, y0, x1, y1] = st.bbox;
  return { mask, x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h, poly: st.hull.map(([x, y]) => [x / w, y / h]) };
}

function localDT(px, w) {
  // exact EDT restricted to a pixel set, computed on its bounding box
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (const i of px) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 + 3, bh = y1 - y0 + 3, m = new Uint8Array(bw * bh);
  for (const i of px) m[((i / w | 0) - y0 + 1) * bw + (i % w) - x0 + 1] = 1;
  const d = distanceTransform(m, bw, bh), out = new Map();
  for (const i of px) out.set(i, d[((i / w | 0) - y0 + 1) * bw + (i % w) - x0 + 1]);
  return out;
}

function coreComponents(sub, w, minSize) {
  const set = new Set(sub), seen = new Set(), out = [];
  for (const s of sub) {
    if (seen.has(s)) continue;
    const q = [s]; seen.add(s); const px = [];
    while (q.length) {
      const i = q.pop(); px.push(i);
      for (const j of [i - 1, i + 1, i - w, i + w]) if (set.has(j) && !seen.has(j)) { seen.add(j); q.push(j); }
    }
    if (px.length >= minSize) out.push(px);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

// Split a blob into n pills: geodesic growth from seed cores, k-means for extra (hidden) pills.
function partition(c, n, seeds, w) {
  const px = c.px;
  const centers = [];
  if (seeds) for (const s of seeds) {
    let sx = 0, sy = 0; for (const i of s) { sx += i % w; sy += (i / w) | 0; }
    centers.push([sx / s.length, sy / s.length]);
  }
  const pts = px.map((i) => [i % w, (i / w) | 0]);
  while (centers.length < n) { // farthest-point seeding for pills not visible as separate cores
    let bi = 0, bd = -1;
    for (let k = 0; k < pts.length; k += 3) {
      let d = Infinity; for (const c2 of centers) d = Math.min(d, (pts[k][0] - c2[0]) ** 2 + (pts[k][1] - c2[1]) ** 2);
      if (!centers.length) d = (pts[k][0] - c.cx) ** 2 + (pts[k][1] - c.cy) ** 2;
      if (d > bd) { bd = d; bi = k; }
    }
    centers.push([...pts[bi]]);
  }
  const fixed = seeds ? seeds.length : 0;
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < 10; it++) {
    for (let k = 0; k < pts.length; k++) {
      let bd = Infinity, bj = 0;
      for (let j = 0; j < n; j++) { const d = (pts[k][0] - centers[j][0]) ** 2 + (pts[k][1] - centers[j][1]) ** 2; if (d < bd) { bd = d; bj = j; } }
      assign[k] = bj;
    }
    if (fixed === n && it > 0) break;
    const acc = Array.from({ length: n }, () => [0, 0, 0]);
    for (let k = 0; k < pts.length; k++) { const a = acc[assign[k]]; a[0] += pts[k][0]; a[1] += pts[k][1]; a[2]++; }
    for (let j = fixed; j < n; j++) if (acc[j][2]) centers[j] = [acc[j][0] / acc[j][2], acc[j][1] / acc[j][2]];
  }
  if (seeds && fixed === n) {
    // geodesic growth from the cores gives cleaner cuts than straight Voronoi lines
    const lab = new Map();
    let frontier = [];
    seeds.forEach((s, j) => s.forEach((i) => { lab.set(i, j); frontier.push(i); }));
    const inBlob = new Set(px);
    while (frontier.length) {
      const nxt = [];
      for (const i of frontier) for (const j of [i - 1, i + 1, i - w, i + w]) if (inBlob.has(j) && !lab.has(j)) { lab.set(j, lab.get(i)); nxt.push(j); }
      frontier = nxt;
    }
    const parts = Array.from({ length: n }, () => []);
    for (const i of px) parts[lab.has(i) ? lab.get(i) : 0].push(i);
    return parts.filter((p) => p.length);
  }
  const parts = Array.from({ length: n }, () => []);
  for (let k = 0; k < pts.length; k++) parts[assign[k]].push(px[k]);
  return parts.filter((p) => p.length);
}

export function deltaE(p, q) { return Math.hypot(0.7 * (p[0] - q[0]), p[1] - q[1], p[2] - q[2]); }

function pillDist(p, g) {
  // normalised distance of a pill to a group's typical pill; > 1 means "different"
  const dc = deltaE(p.lab, g.lab) / g.tolC;
  let ds = 0, da = 0, dt = 0;
  if (p.area && g.area) ds = Math.abs(Math.log(p.area / g.area)) / g.tolS;
  if (p.aspect && g.aspect) da = Math.abs(p.aspect - g.aspect) / g.tolA;
  // two-tone contrast varies with the capsule's angle to the light: compare the class only
  if (!p.inCluster && g.twoTone != null && (p.twoTone > 14) !== (g.twoTone > 14) && Math.abs(p.twoTone - g.twoTone) > 10) dt = 1.5;
  return Math.max(dc, ds, da, dt);
}

function groupPills(pills, unit) {
  // 1) group the clean singles; 2) pills cut out of clumps (whose colour picks up some of
  //    their neighbours) join the nearest existing group unless clearly different.
  const singles = pills.filter((p) => !p.inCluster), clumped = pills.filter((p) => p.inCluster);
  const groups = singles.length ? groupSet(singles, unit) : [];
  const rest = [];
  for (const p of clumped) {
    let bg = null, bd = Infinity;
    for (const g of groups) {
      const d = Math.min(deltaE(p.lab, g.lab), deltaE(p.lab, g.halves[0]), deltaE(p.lab, g.halves[1])) / g.tolC;
      if (d < bd) { bd = d; bg = g; }
    }
    if (bg && bd <= 1.8) { bg.pills.push(p); bg.count++; } else rest.push(p);
  }
  if (rest.length) groups.push(...groupSet(rest, unit));
  return groups;
}

function groupSet(pills, unit) {
  const left = new Set(pills.map((_, i) => i));
  const groups = [];
  while (left.size) {
    // seed from the clean singles still unassigned (or anything if none)
    let ids = [...left].filter((i) => !pills[i].inCluster);
    if (!ids.length) ids = [...left];
    let g = describe(ids.map((i) => pills[i]), unit);
    // choose the medoid as seed so a mixed set does not average into nonsense
    let best = ids[0], bestS = Infinity;
    for (const i of ids) {
      let s = 0; for (const j of ids) s += Math.min(3, pillDist(pills[j], { ...g, lab: pills[i].lab, area: pills[i].area || g.area, aspect: pills[i].aspect || g.aspect, twoTone: pills[i].twoTone }));
      if (s < bestS) { bestS = s; best = i; }
    }
    const seed = pills[best];
    g = { ...g, lab: seed.lab, area: seed.area || g.area, aspect: seed.aspect || g.aspect, twoTone: seed.twoTone };
    let members = [];
    for (let it = 0; it < 3; it++) {
      members = [...left].filter((i) => pillDist(pills[i], g) <= 1);
      if (!members.length) { members = [best]; break; }
      const ng = describe(members.map((i) => pills[i]), unit);
      g = ng;
    }
    if (!members.includes(best)) members.push(best);
    for (const i of members) left.delete(i);
    groups.push({ ...g, pills: members.map((i) => pills[i]), count: members.length });
  }
  return groups;
}

function describe(list, unit) {
  const singles = list.filter((p) => !p.inCluster);
  const src = singles.length ? singles : list;
  const lab = [0, 1, 2].map((k) => median(src.map((p) => p.lab[k])));
  const dEs = src.map((p) => deltaE(p.lab, lab));
  const area = singles.length ? median(singles.map((p) => p.area)) : unit;
  const aspect = singles.length ? median(singles.map((p) => p.aspect)) : null;
  const twoTone = singles.length ? median(singles.map((p) => p.twoTone)) : null;
  const logs = singles.map((p) => Math.log(p.area / area));
  const halves = singles.length ? [0, 1].map((hh) => [0, 1, 2].map((k) => median(singles.map((p) => orientHalves(p, singles[0])[hh][k])))) : [lab, lab];
  return {
    lab, area, aspect, twoTone, halves,
    tolC: Math.max(8, 3.5 * median(dEs) * 1.4826),
    // size/shape alone must differ clearly (>~30% area, >~0.3 aspect) before a pill is called different
    tolS: Math.max(0.27, 3.5 * mad(logs, median(logs))),
    tolA: Math.max(0.3, aspect ? 0.17 * aspect : 0.3),
    tolT: Math.max(9, 3 * mad(singles.map((p) => p.twoTone), twoTone || 0)),
  };
}
function orientHalves(p, ref) {
  // order halves so the lighter half is first; makes two-tone capsules comparable
  const [h1, h2] = p.halves; void ref;
  return h1[0] >= h2[0] ? [h1, h2] : [h2, h1];
}

function summarizeGroup(g, mmPerPx) {
  const twoTone = g.twoTone != null && g.twoTone > 12;
  const colors = twoTone ? [colorName(...g.halves[0]), colorName(...g.halves[1])] : [colorName(...g.lab)];
  const shapes = g.pills.map((p) => p.shape).filter(Boolean);
  const counts = {}; shapes.forEach((s) => (counts[s] = (counts[s] || 0) + 1));
  let shape = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (twoTone) shape = "capsule";
  const lengthPx = g.aspect && g.area ? 2 * Math.sqrt((g.area * g.aspect) / Math.PI) : null;
  return {
    count: g.count, role: g.role, lab: g.lab, rgb: labToRgb(...g.lab),
    halvesRgb: twoTone ? g.halves.map((hh) => labToRgb(...hh)) : null,
    colors, twoTone, shape, aspect: g.aspect, areaPx: g.area, lengthPx,
    lengthMm: mmPerPx && lengthPx ? lengthPx * mmPerPx : null,
  };
}
