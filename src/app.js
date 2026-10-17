// Pill Counter UI. Everything runs offline; the vision engine lives in pillcv.js (worker.js wraps it).
import { analyze } from "./pillcv.js";
import { identify, searchImprint } from "./pill-id.js";
import { nbAvailable, nbStart, nbTorch, nbCapture } from "./native-bridge.js";

/* ============================== helpers ============================== */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pcMedian = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const RMQ = matchMedia("(prefers-reduced-motion: reduce)");
let RM = RMQ.matches;
RMQ.addEventListener && RMQ.addEventListener("change", (e) => { RM = e.matches; });
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}

const COLORS = {
  white: "#f2f2ee", yellow: "#f4d23c", orange: "#f08a2a", red: "#d8333a", pink: "#f09ab4", purple: "#8a5cc4", blue: "#3f6fd6",
  green: "#4aa35a", brown: "#8b5a35", tan: "#d3b186", gray: "#9a9ea3", grey: "#9a9ea3", black: "#2a2a2c", turquoise: "#3cc6c0",
  peach: "#f6c4a0", clear: "#dfe9ee", beige: "#e0cfae", maroon: "#7a2230", teal: "#2a9d9a",
};
const colorHex = (n) => COLORS[String(n || "").toLowerCase()] || "#cfd3d6";
const rgbCss = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/* ============================== state ============================== */
const saved = store.get("pc.settings", {});
const S = {
  mode: saved.mode === "free" ? "free" : "tray",
  roi: null, roiEdit: null, roiShape: "rect",
  mmPerNorm: saved.mmPerNorm || null, calLabel: saved.calLabel || "",
  source: null, frozen: false, busy: false, loopOn: false, epoch: 0, inflight: null,
  res: null, imgW: 0, imgH: 0, fit: "cover",
  frames: [], stableSince: 0, lockedNow: false, liveFast: false, fastAt: 0,
  corr: { adds: [], removed: new Set() },
  lock: null, calibrating: null, stillFrame: null,
  torch: { cap: false, on: false, track: null },
  histIdx: -1, demo: location.hash.includes("demo"), demoLidar: location.hash.includes("demo-lidar"),
  idKey: "", idRows: [], idMatches: [], imprint: "", sheetOpen: false,
};
const app = $("#app"), video = $("#video"), still = $("#still"), demoCv = $("#demo"), cv = $("#overlay"), ctx = cv.getContext("2d");
const persist = () => store.set("pc.settings", { mode: S.mode, mmPerNorm: S.mmPerNorm, calLabel: S.calLabel });

/* ============================== engine (worker + main fallback) ============================== */
class Engine {
  constructor() { this.seq = 0; this.pending = new Map(); this.worker = null; this.mainMod = null; this.startWorker(); }
  startWorker() {
    try {
      if (typeof Worker === "undefined") return;
      const w = new Worker("worker.js", { type: "module" });
      w.onmessage = (e) => {
        const m = e.data || {}; if (m.ready) return;
        const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error)); else { if (p.wantDepth && m.result && !m.result.depth) this.depthMain = true; p.res(m.result); }
      };
      w.onerror = () => this.dropWorker();
      w.onmessageerror = () => this.dropWorker();
      this.worker = w;
    } catch { this.worker = null; }
  }
  dropWorker() {
    if (this.worker) { try { this.worker.terminate(); } catch {} this.worker = null; }
    for (const [, p] of this.pending) p.rej(new Error("worker-failed"));
    this.pending.clear();
  }
  async run(imageData, opts) {
    const { width, height } = imageData;
    if (this.worker && opts && opts.depth && this.depthMain) {
      // worker.js does not return `depth` yet: analyse depth frames on the main thread so LiDAR results still work
      await sleep(0);
      const r = analyze(imageData.data, width, height, opts);
      if (r.width == null) { r.width = width; r.height = height; }
      return r;
    }
    if (this.worker) {
      const id = ++this.seq;
      return new Promise((res, rej) => {
        this.pending.set(id, { res, rej, wantDepth: !!(opts && opts.depth) });
        try { this.worker.postMessage({ id, rgba: imageData.data.buffer, width, height, opts }, [imageData.data.buffer]); }
        catch (e) { this.pending.delete(id); this.dropWorker(); rej(e); }
      });
    }
    // Main-thread fallback (no module worker support, e.g. file://)
    await sleep(0);
    const r = analyze(imageData.data, width, height, opts);
    if (r.width == null) { r.width = width; r.height = height; }
    return r;
  }
}
const engine = new Engine();

/* ============================== identification module ============================== */
let idMod = { identify, searchImprint };
async function loadId() { return idMod; }

/* ============================== result normalisation ============================== */
function normalise(r) {
  r.pills = r.pills || []; r.fragments = r.fragments || []; r.groups = r.groups || []; r.warnings = r.warnings || []; r.blobs = r.blobs || [];
  r.total = r.total != null ? r.total : r.pills.length;
  if (!r.range) r.range = [r.total, r.total];
  if (typeof r.confidence !== "number") {
    const w = { high: 1, medium: 0.75, low: 0.45 };
    let c = r.pills.length ? r.pills.reduce((s, p) => s + (w[p.conf] ?? 0.75), 0) / r.pills.length : 0.3;
    c *= Math.pow(0.9, r.warnings.length); c /= 1 + 0.15 * (r.range[1] - r.range[0]);
    r.confidence = pcClamp(c, 0, 1);
  }
  return r;
}

/* ============================== drug lock / group classification ============================== */
const NEARSHAPE = { round: ["four-sided"], "four-sided": ["round"], oval: ["capsule"], capsule: ["oval"] };
function matchesLock(g) {
  const s = S.lock && S.lock.sig; if (!s) return true;
  const shapeOK = !s.shape || !g.shape || s.shape === g.shape || (NEARSHAPE[s.shape] || []).includes(g.shape);
  const cs = (g.colors || []).map((c) => c.toLowerCase());
  let colorOK = (s.colors || []).some((c) => cs.includes(c.toLowerCase()));
  if (!colorOK && s.rgb && g.rgb) colorOK = Math.hypot(s.rgb[0] - g.rgb[0], s.rgb[1] - g.rgb[1], s.rgb[2] - g.rgb[2]) < 55;
  return shapeOK && colorOK;
}
const isFlagged = (g) => !g ? false : S.lock ? !matchesLock(g) : (g.role === "odd" || g.role === "mixed");
function primaryGroup(res) {
  if (!res) return null;
  if (S.lock) { const m = res.groups.find((g) => matchesLock(g)); if (m) return m; }
  return res.groups.find((g) => g.role === "primary") || res.groups[0] || null;
}
function flaggedInfo(res, removed) {
  let n = 0; const gs = [];
  res.groups.forEach((g, gi) => {
    if (!isFlagged(g)) return;
    let c = g.count || 0;
    if (removed) res.pills.forEach((p, i) => { if (p.group === gi && removed.has(i)) c--; });
    if (c > 0) { n += c; gs.push(g); }
  });
  return { n, groups: gs };
}
function pcDescribe(g) {
  const col = (g.colors && g.colors.length ? g.colors.join("/") : "") + (g.twoTone && (!g.colors || g.colors.length < 2) ? " two-tone" : "");
  return [col, g.shape].filter(Boolean).join(" ") || "unknown pill";
}

/* ============================== display model (smoothing + confidence) ============================== */
function pcbCents(res) { const L = Math.max(res.width || 0, res.height || 0) || 720; return res.pills.map((p) => [p.x / L, p.y / L]); }
function pcbMoved(a, b) {
  // cheap camera-motion check between two centroid sets (normalised to the long side)
  if (!a.length || !b.length) return a.length !== b.length && Math.max(a.length, b.length) > 3;
  const m = (c, i) => c.reduce((s, q) => s + q[i], 0) / c.length;
  if (Math.hypot(m(a, 0) - m(b, 0), m(a, 1) - m(b, 1)) > 0.15) return true;
  const nn = a.map((q) => Math.min(...b.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1])))).sort((x, y) => x - y);
  return nn[nn.length >> 1] > 0.1;
}
function pcbMode(counts) {
  const cnt = new Map(); counts.forEach((c) => cnt.set(c, (cnt.get(c) || 0) + 1));
  let best = 0; for (const c of cnt.values()) best = Math.max(best, c);
  const tops = [...cnt].filter(([, c]) => c === best).map(([v]) => v).sort((x, y) => x - y);
  return { val: tops[(tops.length - 1) >> 1], n: best };
}
function pushFrame(res) {
  const fl = flaggedInfo(res).n, cents = pcbCents(res), prev = S.frames[S.frames.length - 1];
  if (prev && pcbMoved(prev.cents, cents)) { S.frames = []; S.stableSince = 0; }
  S.frames.push({ count: res.total - fl, range: [res.range[0] - fl, res.range[1] - fl], conf: res.confidence, t: performance.now(), res, cents });
  if (S.frames.length > 8) S.frames.shift();
}
function computeDisplay() {
  const fr = S.frames; const last = fr[fr.length - 1];
  if (!last || fr.length < 3) return { count: 0, conf: 0, label: "—", range: [0, 0], stability: 0, locked: false, state: "scan" };
  const recent = fr.slice(-7), md = pcbMode(recent.map((f) => f.count)), med = md.val;
  const stability = md.n / recent.length;
  const conf = pcClamp(last.conf * stability, 0, 1);
  let lo = Math.min(last.range[0], med), hi = Math.max(last.range[1], med);
  if (md.n < recent.length) { lo = Math.min(lo, ...recent.map((f) => f.count)); hi = Math.max(hi, ...recent.map((f) => f.count)); }
  const now = performance.now(); const stable = md.n >= 5 && recent.length >= 5 && last.conf >= 0.85;
  if (stable) { if (!S.stableSince) S.stableSince = now; } else S.stableSince = 0;
  const locked = stable && now - S.stableSince >= 1500;
  let label = confLabel(conf, lo, hi, med);
  if (md.n < recent.length && lo !== hi && !locked) label = `Estimate ${lo}–${hi} — hold steady`;
  return { count: med, conf, range: [lo, hi], stability, locked, state: med === 0 ? "none" : locked ? "lock" : "hold", label };
}
function confLabel(conf, lo, hi, n) {
  const w = hi - lo;
  if (w === 0 && conf >= 0.8) return "Exact";
  if (w <= 2 && conf >= 0.5) return "Likely ±1";
  if (lo === hi) return `Estimate ~${hi}`;
  return `Estimate ${lo}–${hi}`;
}
function frozenDisplay() {
  const res = S.res; const fl = flaggedInfo(res, S.corr.removed).n;
  let removedCounted = 0;
  S.corr.removed.forEach((i) => { const p = res.pills[i]; if (p && !isFlagged(res.groups[p.group])) removedCounted++; });
  const delta = S.corr.adds.length - removedCounted;
  const base = res.total - flaggedInfo(res).n;
  const count = Math.max(0, base + delta);
  const lo = Math.max(0, res.range[0] - flaggedInfo(res).n + delta), hi = Math.max(lo, res.range[1] - flaggedInfo(res).n + delta);
  const adj = S.corr.adds.length || S.corr.removed.size;
  return { count, conf: res.confidence, range: [lo, hi], locked: false, state: "cap", label: adj ? "Manually adjusted" : confLabel(res.confidence, lo, hi, count), adj: !!adj, delta, removedCounted };
}

/* ============================== HUD rendering ============================== */
const hud = $("#hud"), countEl = $("#count");
function makeDigit() {
  const strip = el("span", { class: "strip" }); for (let i = 0; i < 10; i++) strip.append(el("span", { text: i }));
  return el("span", { class: "dg" }, strip);
}
function setRoll(n) {
  const s = String(Math.max(0, n | 0));
  if (countEl._s === s) return;
  const rebuild = !countEl._s || countEl._s.length !== s.length;
  if (rebuild) { countEl.textContent = ""; for (let i = 0; i < s.length; i++) countEl.append(makeDigit()); }
  [...s].forEach((c, i) => {
    const strip = countEl.children[i].firstChild;
    if (rebuild) { strip.style.transition = "none"; strip.style.transform = `translateY(${-c}em)`; strip.offsetHeight; strip.style.transition = ""; }
    else strip.style.transform = `translateY(${-c}em)`;
  });
  countEl._s = s; countEl.setAttribute("aria-label", s);
  if (!RM) { hud.classList.remove("pop"); void hud.offsetWidth; hud.classList.add("pop"); }
}
let lastLocked = false;
function renderHUD(d) {
  setRoll(d.count);
  const pct = Math.round(d.conf * 100);
  $("#confPct").textContent = pct + "%";
  $("#confLabel").textContent = d.label;
  const f = $("#confFill"); f.style.width = pct + "%";
  f.style.setProperty("--c", d.conf >= 0.85 ? "var(--accent)" : d.conf >= 0.55 ? "var(--accent-2)" : d.conf >= 0.35 ? "var(--amber)" : "var(--alert)");
  $("#confBar").setAttribute("aria-valuenow", pct);
  const st = $("#state"); const txt = st.querySelector("span");
  st.className = "state " + (d.state === "lock" ? "lock" : d.state === "hold" ? "hold" : d.state === "cap" ? "cap" : "");
  txt.textContent = d.state === "lock" ? "Locked" : d.state === "hold" ? "Hold steady" : d.state === "cap" ? (S.calibrating ? "Calibrating" : "Captured") : d.state === "none" ? "Looking for pills…" : "Scanning…";
  if (d.locked !== lastLocked) { hud.classList.toggle("locked", d.locked); if (d.locked) { a11y(`Count locked at ${d.count}`); pcxBeep(); pcxSay(String(d.count)); } lastLocked = d.locked; }
  const sub = $("#sub");
  sub.textContent = S.lock ? `Counting ${S.lock.row.name}${S.lock.row.strength ? " " + S.lock.row.strength : ""}` : (S.res && S.res.background ? S.res.background.name || "" : "");
  const c = $("#corr");
  if (d.adj) {
    c.hidden = false;
    const a = S.corr.adds.length, r = S.corr.removed.size;
    $("#corrTxt").textContent = [a ? `+${a} added` : "", r ? `−${r} removed` : ""].filter(Boolean).join(" · ");
  } else c.hidden = true;
  pcxGoal(d); pcbBadge(); nbaHudChip();
}
function a11y(msg) { let n = $("#live"); if (!n) { n = el("div", { id: "live", class: "vh", "aria-live": "polite" }); document.body.append(n); } n.textContent = msg; }

/* ============================== banners & tips ============================== */
const bannersEl = $("#banners"), tipsEl = $("#tips");
let bannerSig = "";
function renderBanners() {
  const res = S.res; const parts = [];
  if (res) {
    const fl = flaggedInfo(res, S.frozen ? S.corr.removed : null);
    if (fl.n > 0) {
      const desc = fl.groups.map(pcDescribe).join(" + ");
      parts.push({ k: "odd", title: `${fl.n} different pill${fl.n > 1 ? "s" : ""} found`, sub: S.lock ? `Not ${S.lock.row.name}: ${desc}` : desc });
    }
    if (res.fragments.length) parts.push({ k: "frag", title: `${res.fragments.length} broken piece${res.fragments.length > 1 ? "s" : ""} (not counted)`, sub: "Partial tablets are shown with a crack marker" });
  }
  const sig = JSON.stringify(parts); if (sig === bannerSig) return; bannerSig = sig;
  const oddP = parts.find((p) => p.k === "odd"); if (oddP) { pcxSay(`Warning. ${oddP.title}`); pcxBuzz([60, 40, 60]); a11y(oddP.title); }
  bannersEl.textContent = "";
  bannersEl.style.cssText = "display:flex;flex-direction:column;gap:6px";
  for (const p of parts) {
    bannersEl.append(el("div", { class: "banner glass " + p.k, role: "alert" },
      el("div", { class: "bi", text: p.k === "odd" ? "!" : "½" }),
      el("div", { class: "grow" }, p.title, el("small", { text: p.sub }))));
  }
}
const TIPS = {
  dark: ["🔦", "Too dark — turn on the light."],
  pile: ["🧩", "Pills are piled up — spread them out for an exact count."],
  "white-on-white": ["⚪", "White pills on a white surface are hard to see — use a dark or blue tray."],
  glare: ["✨", "Glare detected — tilt the tray or move the light."],
  "low-contrast": ["◐", "Low contrast — try a plain, darker tray."],
  noisy: ["▒", "Image is grainy — add light and hold the phone steady."],
};
const TIP_ORDER = ["dark", "pile", "white-on-white", "glare", "low-contrast", "noisy"];
let tipSig = "";
function renderTips() {
  const w = S.res ? S.res.warnings : []; const list = TIP_ORDER.filter((c) => w.includes(c)).slice(0, 2);
  const sig = list.join(",") + S.torch.cap + S.torch.on; if (sig === tipSig) return; tipSig = sig;
  tipsEl.textContent = "";
  for (const c of list) {
    const t = el("div", { class: "tip glass" }, el("span", { class: "t-i", text: TIPS[c][0] }), el("span", { style: "flex:1", text: TIPS[c][1] }));
    if (c === "dark" && S.torch.cap) t.append(el("button", { text: S.torch.on ? "Light off" : "Light on", onclick: toggleTorch }));
    tipsEl.append(t);
  }
}

/* ============================== marker tracking & overlay ============================== */
let markers = [];
let tray = null; // smoothed tray rect (image-normalised)
function statusOf(res, p) {
  const g = res.groups[p.group];
  if (isFlagged(g)) return "odd";
  return p.conf === "low" ? "low" : p.conf === "medium" ? "med" : "ok";
}
function syncMarkers(res, snap) {
  const items = [];
  res.pills.forEach((p, i) => items.push({ kind: "pill", i, x: p.x, y: p.y, a: p.a, b: p.b, th: p.theta || 0, st: statusOf(res, p), hid: !!p.hidden }));
  res.fragments.forEach((f, i) => items.push({ kind: "frag", i, x: f.x, y: f.y, a: f.a, b: f.b, th: f.theta || 0, st: "frag" }));
  const live = markers.filter((m) => !m.dying);
  const pairs = [];
  items.forEach((it, ii) => live.forEach((m, mi) => {
    if (m.kind !== it.kind) return;
    const d = Math.hypot(m.tx - it.x, m.ty - it.y), lim = Math.max(it.a, it.b, m.ta) * 1.6;
    if (d < lim) pairs.push([d, ii, mi]);
  }));
  pairs.sort((p, q) => p[0] - q[0]);
  const ui = new Set(), um = new Set();
  for (const [, ii, mi] of pairs) {
    if (ui.has(ii) || um.has(mi)) continue; ui.add(ii); um.add(mi);
    const m = live[mi], it = items[ii];
    Object.assign(m, { tx: it.x, ty: it.y, ta: it.a, tb: it.b, tth: it.th, st: it.st, i: it.i, hid: it.hid });
    if (snap) Object.assign(m, { x: it.x, y: it.y, a: it.a, b: it.b, th: it.th });
  }
  items.forEach((it, ii) => {
    if (ui.has(ii)) return;
    markers.push({ kind: it.kind, i: it.i, st: it.st, hid: it.hid, x: it.x, y: it.y, a: it.a, b: it.b, th: it.th, tx: it.x, ty: it.y, ta: it.a, tb: it.b, tth: it.th, alpha: snap || RM ? 1 : 0, dying: false, seed: Math.random() * 6 });
  });
  live.forEach((m, mi) => { if (!um.has(mi)) m.dying = true; });
  if (snap || RM) markers = markers.filter((m) => !m.dying);
  // reading-order indices for the frozen view
  if (S.frozen) {
    const ps = markers.filter((m) => m.kind === "pill" && !m.dying);
    const rowH = (pcMedian(ps.map((m) => Math.round(m.tb))) || 20) * 1.6;
    ps.slice().sort((p, q) => Math.round(p.ty / rowH) - Math.round(q.ty / rowH) || p.tx - q.tx).forEach((m, k) => { m.idx = k + 1; });
  }
}
function view() {
  const cw = cv.clientWidth, ch = cv.clientHeight, W = S.imgW || 1, H = S.imgH || 1;
  const s = (S.fit === "cover" ? Math.max : Math.min)(cw / W, ch / H);
  return { s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2, cw, ch };
}
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0);
}
const PAL = { ok: "#19d3c5", med: "#7fe9df", low: "#ffc233", odd: "#ff4d5e", frag: "#ff8f3d", removed: "#9aa0a6", added: "#ffffff" };
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function chip(c, text, x, y, bg, fg = "#fff") {
  c.save(); c.font = "700 11px -apple-system, system-ui, sans-serif"; const w = c.measureText(text).width + 14;
  c.fillStyle = bg; rr(c, x - w / 2, y - 10, w, 20, 10); c.fill(); c.fillStyle = fg; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, x, y + 0.5); c.restore();
}
function lerpAngle(a, b, k) { let d = ((b - a) % Math.PI + Math.PI * 1.5) % Math.PI - Math.PI / 2; return a + d * k; }
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  resizeCanvas(); const V = view(); ctx.clearRect(0, 0, V.cw, V.ch);
  if (PCI.on) { pciDraw(now); return; }
  const k = RM ? 1 : 1 - Math.exp(-dt * 11);
  for (const m of markers) {
    m.x += (m.tx - m.x) * k; m.y += (m.ty - m.y) * k; m.a += (m.ta - m.a) * k; m.b += (m.tb - m.b) * k; m.th = lerpAngle(m.th, m.tth, k);
    m.alpha += ((m.dying ? 0 : 1) - m.alpha) * (RM ? 1 : 1 - Math.exp(-dt * 9));
  }
  markers = markers.filter((m) => !(m.dying && m.alpha < 0.03));
  drawTray(V, dt, now); drawRoi(V, now);
  const t = now / 1000;
  if (S.frozen && PCX.groupsOn && S.res) pcxDrawGroups(V);
  for (const m of markers) if (m.kind === "frag") drawFrag(V, m);
  for (const m of markers) if (m.kind === "pill") drawPill(V, m, t);
  if (S.frozen) { const a = S.stillAdds || S.corr.adds; for (const p of S.corr.adds) drawAdded(V, p, t); }
  if (S.frozen && PCX.verify && PCX.verify.state === "diff") pcxDrawDiff(V, t);
  if (!markers.length && !S.frozen && !S.roiEdit && S.source) drawReticle(V, t);
  pcxAutoTick(now);
}
function drawReticle(V, t) {
  const w = Math.min(V.cw, V.ch) * 0.62, x = V.cw / 2 - w / 2, y = V.ch * 0.46 - w / 2, l = 26 + (RM ? 0 : Math.sin(t * 2) * 3);
  ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 3; ctx.lineCap = "round";
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + w, 1, -1], [x + w, y + w, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(cx, cy + sy * l); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * l, cy); ctx.stroke();
  }
  ctx.restore();
}
function drawPill(V, m, t) {
  const x = V.ox + m.x * V.s, y = V.oy + m.y * V.s, A = m.a * V.s, B = m.b * V.s;
  const removed = S.frozen && S.corr.removed.has(m.i);
  if (m.hid && !removed) { nbaDrawGhost(x, y, A, B, m, t); return; }
  const st = removed ? "removed" : m.st, col = PAL[st];
  ctx.save(); ctx.globalAlpha = pcClamp(m.alpha, 0, 1);
  ctx.translate(x, y);
  const sc = RM ? 1 : 0.85 + 0.15 * m.alpha; ctx.scale(sc, sc);
  if (st === "odd") {
    const p = RM ? 0.35 : ((t + m.seed) % 1.4) / 1.4, rf = 1.15 + p * 0.9;
    ctx.save(); ctx.rotate(m.th); ctx.strokeStyle = col; ctx.globalAlpha *= RM ? 0.7 : 0.85 * (1 - p); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 0, A * rf + 4, B * rf + 4, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  ctx.rotate(m.th);
  const ea = A + 2, eb = B + 2;
  ctx.beginPath(); ctx.ellipse(0, 0, ea, eb, 0, 0, Math.PI * 2);
  ctx.fillStyle = col + (PCX.o.contrast ? "55" : st === "odd" ? "40" : "1c"); ctx.fill();
  ctx.lineJoin = "round";
  if (st === "low" || st === "removed") { ctx.setLineDash([7, 5]); ctx.lineDashOffset = RM ? 0 : -t * 14; }
  const hw = PCX.o.contrast ? 1.8 : 0;
  ctx.strokeStyle = PCX.o.contrast ? "#000" : "rgba(0,0,0,.45)"; ctx.lineWidth = 5 + hw * 1.5; ctx.stroke();
  ctx.strokeStyle = col; ctx.lineWidth = (st === "odd" ? 3.2 : st === "med" ? 2 : 2.6) + hw; ctx.stroke();
  ctx.setLineDash([]);
  ctx.rotate(-m.th);
  if (removed) { const r = Math.min(A, B) * 0.55; ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke(); }
  else if (S.frozen && m.idx) {
    const fs = pcClamp(Math.min(A, B) * 0.95, 10, 22); ctx.font = `700 ${fs}px -apple-system, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.strokeText(m.idx, 0, 1); ctx.fillStyle = "#fff"; ctx.fillText(m.idx, 0, 1);
  }
  ctx.restore();
  if (st === "odd" && m.alpha > 0.5) chip(ctx, "DIFFERENT", x, y - Math.max(A, B) - 12, PAL.odd);
  else if (st === "low" && S.frozen && m.alpha > 0.5) chip(ctx, "UNSURE", x, y - Math.max(A, B) - 10, "rgba(120,80,0,.85)", "#ffd36b");
}
function drawFrag(V, m) {
  const x = V.ox + m.x * V.s, y = V.oy + m.y * V.s, A = m.a * V.s, B = m.b * V.s;
  ctx.save(); ctx.globalAlpha = pcClamp(m.alpha, 0, 1); ctx.translate(x, y); ctx.rotate(m.th);
  ctx.beginPath(); ctx.ellipse(0, 0, A + 3, B + 3, 0, 0, Math.PI * 2);
  ctx.setLineDash([2, 5]); ctx.lineCap = "round"; ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = PAL.frag; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
  const r = Math.max(A, B) * 0.7; ctx.beginPath(); ctx.moveTo(-r * 0.15, -r * 0.8);
  [[0.1, -0.4], [-0.15, -0.1], [0.12, 0.25], [-0.05, 0.8]].forEach(([a, b]) => ctx.lineTo(a * r, b * r));
  ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 4.5; ctx.stroke(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}
function drawAdded(V, p, t) {
  const x = V.ox + p.x * V.s, y = V.oy + p.y * V.s, r = p.r * V.s;
  ctx.save(); ctx.translate(x, y); const pop = RM ? 1 : Math.min(1, (performance.now() - p.t) / 250), s = 0.6 + 0.4 * (1 - Math.pow(1 - pop, 3)); ctx.scale(s, s);
  ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.6; ctx.stroke();
  const q = r * 0.45; ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-q, 0); ctx.lineTo(q, 0); ctx.moveTo(0, -q); ctx.lineTo(0, q); ctx.stroke();
  ctx.restore(); chip(ctx, "ADDED", x, y - r - 12, "rgba(30,30,30,.85)");
}
function drawTray(V, dt, now) {
  const tr = S.mode === "tray" && S.res && S.res.tray && !S.roi ? S.res.tray : null;
  if (!tr) { tray = null; return; }
  const W = S.imgW, H = S.imgH, tgt = { x: tr.x * W, y: tr.y * H, w: tr.w * W, h: tr.h * H };
  if (!tray || RM || S.frozen) tray = { ...tgt }; else { const k = 1 - Math.exp(-dt * 6); for (const q of ["x", "y", "w", "h"]) tray[q] += (tgt[q] - tray[q]) * k; }
  const x = V.ox + tray.x * V.s, y = V.oy + tray.y * V.s, w = tray.w * V.s, h = tray.h * V.s;
  const path = () => { if (tr.poly && tr.poly.length > 2) { tr.poly.forEach((q, i) => (i ? ctx.lineTo(V.ox + q[0] * W * V.s, V.oy + q[1] * H * V.s) : ctx.moveTo(V.ox + q[0] * W * V.s, V.oy + q[1] * H * V.s))); ctx.closePath(); } else if (tr.shape === "ellipse") { ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); } else { rr(ctx, x, y, w, h, Math.min(24, w / 6, h / 6)); } };
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, V.cw, V.ch); path(); ctx.fillStyle = "rgba(0,0,0,.38)"; ctx.fill("evenodd");
  ctx.beginPath(); path(); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke(); ctx.restore();
}
function drawRoi(V, now) {
  const r = S.roiEdit || S.roi; if (!r) return; const W = S.imgW, H = S.imgH;
  const x = V.ox + r.x * W * V.s, y = V.oy + r.y * H * V.s, w = r.w * W * V.s, h = r.h * H * V.s;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, V.cw, V.ch);
  if (r.shape === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); else rr(ctx, x, y, w, h, 10);
  ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fill("evenodd");
  ctx.beginPath(); if (r.shape === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); else rr(ctx, x, y, w, h, 10);
  ctx.setLineDash(S.roiEdit ? [] : [8, 6]); ctx.lineDashOffset = RM ? 0 : -now / 60; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.stroke(); ctx.restore();
}

/* ============================== sources: camera / demo / photo ============================== */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("getUserMedia unavailable (needs https:// or localhost)");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (e) {
    if (e && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    else throw e;
  }
  video.srcObject = stream; video.muted = true; video.setAttribute("playsinline", "");
  await video.play();
  for (let i = 0; i < 50 && !video.videoWidth; i++) await sleep(60);
  if (!video.videoWidth) throw new Error("camera gave no frames");
  const track = stream.getVideoTracks()[0]; S.torch.track = track;
  try { const caps = track.getCapabilities ? track.getCapabilities() : {}; S.torch.cap = !!caps.torch; } catch { S.torch.cap = false; }
  $("#btnTorch").hidden = !S.torch.cap;
  S.source = { kind: "video", el: video, dims: () => [video.videoWidth, video.videoHeight], min: 0 };
  app.dataset.src = "video"; S.fit = "cover";
}
async function toggleTorch() {
  if (S.source && S.source.kind === "native") { S.torch.on = !S.torch.on; try { nbTorch(S.torch.on); } catch { S.torch.on = false; toast("Light not available on this camera"); } $("#btnTorch").setAttribute("aria-pressed", S.torch.on); tipSig = ""; renderTips(); return; }
  if (!S.torch.track) return;
  try { S.torch.on = !S.torch.on; await S.torch.track.applyConstraints({ advanced: [{ torch: S.torch.on }] }); }
  catch { S.torch.on = false; toast("Light not available on this camera"); }
  $("#btnTorch").setAttribute("aria-pressed", S.torch.on); tipSig = ""; renderTips();
}

/* ---- synthetic demo scene (#demo) ---- */
function startDemo() {
  demoCv.width = 720; demoCv.height = 960; const g = demoCv.getContext("2d");
  const slots = []; for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) slots.push([100 + c * 130, 215 + r * 135]);
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const lidar = S.demoLidar; let demoDepth = null;
  const base = slots.map((p, i) => ({ x: p[0] + (rnd() - 0.5) * 22, y: p[1] + (rnd() - 0.5) * 22, th: rnd() * Math.PI, kind: i === 12 ? "odd" : i === 23 ? "half" : "white" }));
  let n = 0;
  const draw = () => {
    n++;
    g.fillStyle = "#2a2e35"; g.fillRect(0, 0, 720, 960);
    const bg = g.createLinearGradient(0, 100, 720, 860); bg.addColorStop(0, "#2f67b8"); bg.addColorStop(1, "#1f4a92");
    g.fillStyle = bg; rr(g, 40, 100, 640, 760, 28); g.fill();
    for (const p of base) {
      const x = p.x + (Math.random() - 0.5) * 2, y = p.y + (Math.random() - 0.5) * 2, th = p.th + (Math.random() - 0.5) * 0.03;
      const A = 38, B = p.kind === "odd" ? 38 : 25;
      g.save(); g.translate(x, y); g.rotate(th);
      g.shadowColor = "rgba(0,0,0,.45)"; g.shadowBlur = 12; g.shadowOffsetY = 5;
      const grad = g.createRadialGradient(-A * 0.3, -B * 0.4, 2, 0, 0, A);
      if (p.kind === "odd") { grad.addColorStop(0, "#ff9a5c"); grad.addColorStop(1, "#c8441f"); } else { grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#d9dcdf"); }
      g.fillStyle = grad; g.beginPath();
      if (p.kind === "half") { g.ellipse(0, 0, A, B, 0, -Math.PI / 2, Math.PI / 2); g.closePath(); } else g.ellipse(0, 0, A, B, 0, 0, Math.PI * 2);
      g.fill(); g.shadowColor = "transparent";
      if (p.kind !== "half") { g.strokeStyle = "rgba(0,0,0,.12)"; g.lineWidth = 2; g.beginPath(); g.moveTo(-A * 0.6, 0); g.lineTo(A * 0.6, 0); g.stroke(); }
      g.restore();
    }
    g.fillStyle = "rgba(255,255,255,.04)"; g.fillRect(0, (n * 7) % 960, 720, 40);
    if (lidar) demoDepth = nbaDemoDepth(base);
  };
  draw();
  S.source = { kind: "demo", el: demoCv, dims: () => [720, 960], min: 500, tick: draw, getDepth: lidar ? () => demoDepth : null };
  app.dataset.src = "demo"; S.fit = "cover";
  S.imgW = 720; S.imgH = 960;
  $("#btnTorch").hidden = true;
}

/* ---- file/photo fallback ---- */
async function fileToCanvas(file, maxLong) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight, sc = Math.min(1, maxLong / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
  return c;
}

/* ---- native iPhone camera + LiDAR (nba*) ---- */
const nbaDM = new WeakMap(); // canvas -> depth object whose intrinsics are in that canvas's pixel units
function nbaRot(a, w, h, C) { // rotate a w*h array 90 deg clockwise -> (h wide, w tall)
  const o = new C(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + (h - 1 - y)] = a[y * w + x];
  return o;
}
function nbaRotateFrame(f) {
  const W = f.width, H = f.height, it = f.intrinsics, d = f.depth;
  const rgba = new Uint8ClampedArray(W * H * 4), s = f.rgba;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, j = (x * H + (H - 1 - y)) * 4;
    rgba[j] = s[i]; rgba[j + 1] = s[i + 1]; rgba[j + 2] = s[i + 2]; rgba[j + 3] = s[i + 3];
  }
  const tf = (q) => ({ fx: q.fy, fy: q.fx, cx: (H - 1) - q.cy, cy: q.cx });
  const out = { rgba, width: H, height: W, intrinsics: tf(it), depth: null };
  if (d) out.depth = { data: nbaRot(d.data, d.w, d.h, Float32Array), w: d.h, h: d.w, conf: d.conf ? nbaRot(d.conf, d.w, d.h, Uint8Array) : null, ...tf(d) };
  return out;
}
function nbaPaint(c, fr) {
  if (c.width !== fr.width || c.height !== fr.height) { c.width = fr.width; c.height = fr.height; }
  c.getContext("2d").putImageData(new ImageData(fr.rgba, fr.width, fr.height), 0, 0);
}
function nbaScaleDepth(d, k) { return k === 1 ? d : { ...d, fx: d.fx * k, fy: d.fy * k, cx: d.cx * k, cy: d.cy * k }; }
function nbaDepthFor(srcCanvas, w) { const d = nbaDM.get(srcCanvas); return d ? nbaScaleDepth(d, w / srcCanvas.width) : null; }
// crop (x0,y0,cs square, in source px) then scale by k: depth map is cropped to the same region, intrinsics shifted then scaled
function nbaCropDepth(d, x0, y0, cs, k, W, H) {
  const rx = d.w / W, ry = d.h / H;
  const dx0 = pcClamp(Math.round(x0 * rx), 0, d.w - 2), dy0 = pcClamp(Math.round(y0 * ry), 0, d.h - 2);
  const dw = pcClamp(Math.round(cs * rx), 2, d.w - dx0), dh = pcClamp(Math.round(cs * ry), 2, d.h - dy0);
  const data = new Float32Array(dw * dh), conf = d.conf ? new Uint8Array(dw * dh) : null;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const si = (dy0 + y) * d.w + dx0 + x; data[y * dw + x] = d.data[si]; if (conf) conf[y * dw + x] = d.conf[si]; }
  return { data, w: dw, h: dh, conf, fx: d.fx * k, fy: d.fy * k, cx: (d.cx - x0) * k, cy: (d.cy - y0) * k };
}
async function nbaNextFrame(src) {
  for (let i = 0; i < 120 && src.seq === src.used; i++) await sleep(15);
  src.used = src.seq;
}
function nbaStartNative() {
  const c = document.createElement("canvas");
  const src = { kind: "native", el: c, dims: () => [c.width, c.height], min: 0, seq: 0, used: 0, cur: null, getDepth: () => (src.cur && src.cur.depth) || null };
  return new Promise((resolve, reject) => {
    let first = true;
    const timer = setTimeout(() => { if (first) reject(new Error("no frames from the native camera")); }, 8000);
    nbStart((f) => {
      try { const r = nbaRotateFrame(f); nbaPaint(c, r); src.cur = r; src.seq++; } catch (e) { return; }
      if (first) {
        first = false; clearTimeout(timer);
        S.source = src; app.dataset.src = "video"; S.fit = "cover"; S.imgW = c.width; S.imgH = c.height;
        S.torch.cap = true; $("#btnTorch").hidden = false;
        resolve();
      }
    }, (m) => { if (first) { first = false; clearTimeout(timer); reject(new Error(m)); } else console.warn("[native]", m); });
  });
}
const nbaDepthUsed = () => !!(S.res && S.res.depth && S.res.depth.used);
function nbaMmNorm() { // millimetres per normalised image (long side): LiDAR first, else coin calibration
  if (nbaDepthUsed() && S.res.depth.mmPerPx > 0) return S.res.depth.mmPerPx * Math.max(S.res.width || S.imgW, S.res.height || S.imgH);
  return S.mmPerNorm;
}
function nbaHudChip() {
  let c = $("#nbaChip");
  if (!c) { const sub = $("#sub"); c = el("span", { id: "nbaChip", text: "LiDAR", style: "display:block;width:fit-content;align-self:flex-start;font-size:11px;font-weight:700;letter-spacing:.04em;margin-top:2px;padding:1px 8px;border-radius:9px;background:var(--accent);color:var(--accent-ink)" }); sub.parentNode.insertBefore(c, sub.nextSibling); }
  const on = nbaDepthUsed(); c.hidden = !on;
  const cal = $("#btnCal"); if (cal) cal.hidden = on; // LiDAR gives mm directly: no coin calibration needed
}
function nbaDrawGhost(x, y, A, B, m, t) {
  ctx.save(); ctx.globalAlpha = pcClamp(m.alpha, 0, 1) * 0.9; ctx.translate(x, y); ctx.rotate(m.th);
  ctx.beginPath(); ctx.ellipse(0, 0, A + 2, B + 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.08)"; ctx.fill();
  ctx.setLineDash([6, 5]); ctx.lineDashOffset = RM ? 0 : -t * 10; ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  if (m.alpha > 0.5) chip(ctx, "under", x, y, "rgba(30,30,30,.75)", "#dfe6ea");
}
// #demo-lidar: flat tray plane at 0.28 m, pills raised ~3.5 mm, fx = fy = pxPerMm * 280 (demo image pixels)
const NBA_DEMO_PXMM = 5.2;
function nbaDemoDepth(pills) {
  const dw = 192, dh = 256, W = 720, H = 960, k = W / dw, data = new Float32Array(dw * dh), conf = new Uint8Array(dw * dh).fill(2);
  for (let i = 0; i < data.length; i++) data[i] = 0.28 + (Math.random() - 0.5) * 0.0006;
  for (const p of pills) {
    const A = 38, B = p.kind === "odd" ? 38 : 25, c = Math.cos(-p.th), s = Math.sin(-p.th), r = Math.max(A, B) / k + 2;
    for (let y = Math.max(0, Math.floor(p.y / k - r)); y <= Math.min(dh - 1, Math.ceil(p.y / k + r)); y++)
      for (let x = Math.max(0, Math.floor(p.x / k - r)); x <= Math.min(dw - 1, Math.ceil(p.x / k + r)); x++) {
        const dx = (x + 0.5) * k - p.x, dy = (y + 0.5) * k - p.y, u = (dx * c - dy * s) / A, v = (dx * s + dy * c) / B, q = u * u + v * v;
        if (q <= 1 && !(p.kind === "half" && u < 0)) data[y * dw + x] = 0.28 - 0.0035 * (1 - 0.25 * q);
      }
  }
  const f = NBA_DEMO_PXMM * 280;
  return { data, w: dw, h: dh, conf, fx: f, fy: f, cx: (W - 1) / 2, cy: (H - 1) / 2 };
}

/* ---- frame grabbing ---- */
let liveCv = null;
function grab(maxLong) {
  const src = S.source; const [w, h] = src.dims(); const sc = Math.min(1, maxLong / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
  const c = maxLong > 1000 ? document.createElement("canvas") : (liveCv || (liveCv = document.createElement("canvas")));
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(src.el, 0, 0, cw, ch);
  const dp = src.getDepth ? src.getDepth() : null;
  nbaDM.set(c, dp ? nbaScaleDepth(dp, cw / w) : null);
  return { canvas: c, w: cw, h: ch };
}
// high-res still: native iPhone capture (with LiDAR depth) or a plain canvas grab
async function grabHi() {
  if (S.source && S.source.kind === "native") {
    const r = nbaRotateFrame(await nbCapture()), c = document.createElement("canvas");
    nbaPaint(c, r); nbaDM.set(c, r.depth || null);
    return { canvas: c, w: c.width, h: c.height };
  }
  return grab(2048);
}
function scaledCanvas(c, maxSide) {
  const k = Math.min(1, maxSide / Math.max(c.width, c.height));
  if (k === 1) return c;
  const o = document.createElement("canvas"); o.width = Math.round(c.width * k); o.height = Math.round(c.height * k);
  o.getContext("2d").drawImage(c, 0, 0, o.width, o.height);
  return o;
}
const imageDataOf = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
const mmPerPxFor = (w, h) => (S.mmPerNorm ? S.mmPerNorm / Math.max(w, h) : undefined);
function engineOpts(w, h, fast = false, depthSrc = null) {
  // live frames: fast estimator; captured stills: full silhouette fitting for the exact count
  const o = { mode: S.mode, fast };
  if (S.roi) o.roi = { shape: S.roi.shape, x: S.roi.x, y: S.roi.y, w: S.roi.w, h: S.roi.h };
  const dp = depthSrc ? nbaDepthFor(depthSrc, w) : null;
  if (dp) o.depth = dp;
  const mm = mmPerPxFor(w, h); if (mm && !dp) o.mmPerPx = mm;
  return o;
}

/* ============================== live loop ============================== */
async function liveLoop() {
  if (S.loopOn) return; S.loopOn = true;
  while (S.source && !S.frozen && !PCI.on) {
    const t0 = performance.now();
    try {
      if (S.source.kind === "native") await nbaNextFrame(S.source);
      if (S.source.tick && !document.hidden) S.source.tick();
      const epoch = S.epoch;
      const f = grab(720);
      if (S.liveFast && t0 - S.fastAt > 3000) S.liveFast = false; // retry full mode every ~3 s
      const wasFast = S.liveFast;
      S.inflight = engine.run(imageDataOf(f.canvas), engineOpts(f.w, f.h, wasFast, f.canvas));
      const raw = await S.inflight; S.inflight = null;
      const rt = performance.now() - t0;
      if (!wasFast && rt > 900) { S.liveFast = true; S.fastAt = performance.now(); }
      pcbDbg(`live ${wasFast ? "fast" : "full"} ${Math.round(rt)}ms`);
      if (S.frozen || epoch !== S.epoch) continue;
      onLive(normalise(raw), f);
    } catch (e) { S.inflight = null; await sleep(120); }
    const wait = (S.source.min || 0) - (performance.now() - t0);
    await sleep(Math.max(document.hidden ? 300 : 8, wait));
  }
  S.loopOn = false;
}
function onLive(res, f) {
  pushFrame(res);
  const d = computeDisplay(), fr = S.frames;
  let pick = fr[fr.length - 1]; for (let i = fr.length - 1; i >= 0; i--) if (fr[i].count === d.count) { pick = fr[i]; break; } // markers must match the number shown
  const r = d.count > 0 || fr.length >= 3 ? pick.res : res;
  S.res = r; S.imgW = r.width || f.w; S.imgH = r.height || f.h;
  syncMarkers(r, false); renderHUD(d); renderBanners(); renderTips(); updateHint(); scheduleId();
}
function pcbDbg(t) {
  if (!S.demo) return; let e = $("#pcbDbg");
  if (!e) { e = el("div", { id: "pcbDbg", style: "position:fixed;left:6px;bottom:2px;font:10px monospace;color:#9fe;z-index:99;pointer-events:none" }); document.body.append(e); }
  e.textContent = t;
}
function resetStability() { S.epoch++; S.frames = []; S.stableSince = 0; lastLocked = false; hud.classList.remove("locked"); }

/* ============================== capture / freeze / retake ============================== */
async function capture() {
  if (S.busy || S.frozen || !S.source) return;
  PCX.verify = null; PCX.hit = false;
  S.busy = true; app.classList.add("busy");
  try { if (S.inflight) await S.inflight.catch(() => {}); } catch {}
  if (PCX.o.burst && S.source.kind !== "photo" && !S.calibrating) {
    let done = false;
    try { done = await pcbBurst(); } catch (e) { done = false; }
    if (done) return;
    if (S.frozen) { setHint(""); await analyseStill(true); return; } // burst failed after freezing: single analysis of the frozen frame
  }
  let f;
  try { f = await grabHi(); } catch (e) { S.busy = false; app.classList.remove("busy"); return toast("Could not capture a photo"); }
  freezeWith(f.canvas);
  S.fit = S.source.kind === "photo" ? "contain" : "cover";
  await analyseStill(true);
}

/* ---- burst consensus capture (pcb*) ---- */
const PCB_N = 3, PCB_GAP = 120;
function pcbSharp(c) {
  const k = Math.min(1, 320 / Math.max(c.width, c.height)), w = Math.max(8, Math.round(c.width * k)), h = Math.max(8, Math.round(c.height * k));
  const o = document.createElement("canvas"); o.width = w; o.height = h;
  const g = o.getContext("2d", { willReadFrequently: true }); g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, gr = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gr[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, v = 4 * gr[i] - gr[i - 1] - gr[i + 1] - gr[i - w] - gr[i + w]; s += v; s2 += v * v; n++; }
  return n ? s2 / n - (s / n) * (s / n) : 0;
}
function pcbConsensus(totals) {
  const cnt = new Map(); totals.forEach((t) => cnt.set(t, (cnt.get(t) || 0) + 1));
  let best = -1, val = totals[0];
  for (const [t, c] of cnt) if (c > best) { best = c; val = t; }
  if (best === 1 && totals.length > 1) { const s = [...totals].sort((a, b) => a - b); val = s[(s.length - 1) >> 1]; }
  const n = totals.length, agree = best > 1 ? best : 1;
  const factor = n < 2 ? 1 : agree === n ? 1 : agree > 1 ? 0.85 : 0.6;
  return { total: val, agree, n, factor };
}
async function pcbBurst() {
  const fr = [];
  for (let i = 0; i < PCB_N; i++) {
    if (i) await sleep(PCB_GAP);
    if (S.source.tick) S.source.tick();
    const f = await grabHi(); fr.push({ canvas: f.canvas, sharp: pcbSharp(f.canvas), res: null });
  }
  S.fit = "cover";
  const sharpest = fr.reduce((a, b) => (b.sharp > a.sharp ? b : a));
  freezeWith(sharpest.canvas);
  for (let i = 0; i < fr.length; i++) {
    setHint(`Checking ${i + 1}/${fr.length}…`);
    try {
      const a = scaledCanvas(fr[i].canvas, 1600);
      fr[i].res = normalise(await engine.run(imageDataOf(a), engineOpts(a.width, a.height, false, fr[i].canvas)));
    } catch (e) { fr[i].res = null; }
  }
  const ok = fr.filter((f) => f.res);
  if (!ok.length) { setHint(""); return false; }
  const cons = pcbConsensus(ok.map((f) => f.res.total));
  const matching = ok.filter((f) => f.res.total === cons.total);
  const pick = matching.filter((f) => f.res.pills.length === cons.total).reduce((a, b) => (!a || b.sharp > a.sharp ? b : a), null)
    || matching.reduce((a, b) => (b.sharp > a.sharp ? b : a));
  const res = pick.res, totals = ok.map((f) => f.res.total);
  res.confidence = pcClamp(res.confidence * cons.factor, 0, 1);
  res.range = [Math.min(res.range[0], ...totals), Math.max(res.range[1], ...totals)];
  if (pick.canvas !== S.stillFrame) freezeWith(pick.canvas);
  S.burst = { agree: cons.agree, n: cons.n, requested: fr.length, estimate: res.pills.length !== cons.total };
  setHint("");
  await analyseStill(true, res);
  return true;
}
function pcbBadge() {
  let b = $("#pcbBadge");
  if (!b) { const sub = $("#sub"); b = el("div", { id: "pcbBadge", style: "font-size:12px;font-weight:600;margin-top:2px" }); sub.parentNode.insertBefore(b, sub.nextSibling); }
  const B = S.frozen && S.burst;
  if (!B) { b.hidden = true; return; }
  const all = B.agree === B.n && B.n > 1;
  b.hidden = false;
  b.textContent = (B.n < 2 ? "1 frame" : all ? `${B.n}/${B.n} frames agree` : B.agree > 1 ? `${B.agree}/${B.n} frames agree` : "frames disagree — hold steady and recount") + (B.estimate ? " · estimate" : "");
  b.style.color = all ? "var(--accent)" : B.agree > 1 ? "var(--accent-2)" : "var(--amber)";
}
function freezeWith(canvas) {
  S.burst = null; S.frozen = true; S.stillFrame = canvas;
  still.width = canvas.width; still.height = canvas.height; still.getContext("2d").drawImage(canvas, 0, 0);
  still.classList.toggle("contain", S.fit === "contain");
  app.classList.add("frozen"); S.imgW = canvas.width; S.imgH = canvas.height;
  markers = []; S.corr = { adds: [], removed: new Set() };
  $("#shutter").hidden = true; $("#retake").hidden = false;
  $("#btnSave").hidden = false; $("#btnRecount").hidden = !(S.source && S.source.kind !== "photo");
}
async function analyseStill(save, pre) {
  S.busy = true; app.classList.add("busy");
  const c = S.stillFrame; if (!pre) S.burst = null;
  try {
    let res = pre;
    if (!res) { const a = scaledCanvas(c, 1600); res = normalise(await engine.run(imageDataOf(a), engineOpts(a.width, a.height, false, c))); }
    S.res = res; S.imgW = res.width || c.width; S.imgH = res.height || c.height;
    S.corr = { adds: [], removed: new Set() };
    syncMarkers(res, true); refreshFrozenUI();
    if (save && !S.calibrating) saveHistory(true);
    scheduleId(true);
    if (S.calibrating) showGuide(`Tap the ${S.calibrating.label} in the photo`);
    else if (res.total > 0) setHint("Tap a marker to remove it · tap empty space to add a pill");
    if (!S.calibrating) { const fd = frozenDisplay(), fn = flaggedInfo(res, S.corr.removed).n; pcxSay(`${fd.count} pill${fd.count === 1 ? "" : "s"}${fn ? `. ${fn} different pill${fn > 1 ? "s" : ""} found` : ""}`); }
  } catch (e) {
    toast("Could not analyse this image");
  }
  S.busy = false; app.classList.remove("busy");
}
function refreshFrozenUI() { renderHUD(frozenDisplay()); renderBanners(); renderTips(); }
function retake() {
  S.frozen = false; app.classList.remove("frozen", "busy"); S.busy = false; S.calibrating = null; $("#guide").hidden = true;
  S.corr = { adds: [], removed: new Set() }; markers = []; S.res = null; S.burst = null; S.histIdx = -1; setHint("");
  $("#shutter").hidden = false; $("#retake").hidden = true; bannerSig = ""; tipSig = "";
  $("#btnSave").hidden = true; $("#btnRecount").hidden = true; PCX.verify = null; PCX.hit = false; renderBanners(); renderTips();
  resetStability(); renderHUD(computeDisplay());
  if (S.source && S.source.kind === "photo") { S.source = null; showFallback("Take another photo", "Photo mode — no live camera."); return; }
  S.fit = "cover"; liveLoop();
}

/* ---- manual corrections on the frozen photo ---- */
function toImage(px, py) { const V = view(); return [(px - V.ox) / V.s, (py - V.oy) / V.s]; }
function hitPill(x, y) {
  let best = -1, bd = 1e9;
  S.res.pills.forEach((p, i) => {
    const dx = x - p.x, dy = y - p.y, c = Math.cos(-(p.theta || 0)), s = Math.sin(-(p.theta || 0));
    const u = (dx * c - dy * s) / (p.a * 1.25 + 4), v = (dx * s + dy * c) / (p.b * 1.25 + 4), d = u * u + v * v;
    if (d <= 1 && d < bd) { bd = d; best = i; }
  });
  return best;
}
function onTap(px, py) {
  if (!S.frozen || !S.res || S.busy) return;
  const [x, y] = toImage(px, py);
  if (S.calibrating) return calibrateAt(x, y);
  const i = hitPill(x, y);
  if (i >= 0) { S.corr.removed.has(i) ? S.corr.removed.delete(i) : S.corr.removed.add(i); }
  else {
    const near = S.corr.adds.findIndex((a) => Math.hypot(a.x - x, a.y - y) < a.r);
    if (near >= 0) S.corr.adds.splice(near, 1);
    else {
      if (x < 0 || y < 0 || x > S.imgW || y > S.imgH) return;
      const r = (pcMedian(S.res.pills.map((p) => Math.round(Math.min(p.a, p.b)))) || 16);
      S.corr.adds.push({ x, y, r, t: performance.now() });
    }
  }
  refreshFrozenUI(); saveHistory(false); scheduleId();
}
$("#corrReset").addEventListener("click", () => { S.corr = { adds: [], removed: new Set() }; refreshFrozenUI(); saveHistory(false); });

/* ============================== pointer: tap + ROI drag ============================== */
let drag = null;
cv.addEventListener("pointerdown", (e) => {
  const r = cv.getBoundingClientRect(); drag = { x0: e.clientX - r.left, y0: e.clientY - r.top, x: e.clientX - r.left, y: e.clientY - r.top, moved: false };
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener("pointermove", (e) => {
  if (!drag) return; const r = cv.getBoundingClientRect(); drag.x = e.clientX - r.left; drag.y = e.clientY - r.top;
  if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 8) drag.moved = true;
  if (S.roiEdit && drag.moved) {
    const [ax, ay] = toImage(drag.x0, drag.y0), [bx, by] = toImage(drag.x, drag.y);
    const nx0 = pcClamp(Math.min(ax, bx) / S.imgW, 0, 1), nx1 = pcClamp(Math.max(ax, bx) / S.imgW, 0, 1), ny0 = pcClamp(Math.min(ay, by) / S.imgH, 0, 1), ny1 = pcClamp(Math.max(ay, by) / S.imgH, 0, 1);
    S.roiEdit = { shape: S.roiShape, x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
  }
});
cv.addEventListener("pointerup", () => {
  if (!drag) return; const d = drag; drag = null;
  if (S.roiEdit) return;
  if (!d.moved) onTap(d.x, d.y);
});
cv.addEventListener("pointercancel", () => { drag = null; });

/* ---- ROI ("Set area") ---- */
function startRoi() {
  if (S.roiEdit || app.classList.contains("roi-edit")) return endRoi(false);
  S.roiEdit = S.roi ? { ...S.roi } : null; S.roiShape = S.roi ? S.roi.shape : "rect";
  app.classList.add("roi-edit"); $("#btnArea").setAttribute("aria-pressed", "true");
  showGuide("Drag to outline the area to count", true);
}
function endRoi(apply) {
  const e = S.roiEdit; app.classList.remove("roi-edit"); $("#btnArea").setAttribute("aria-pressed", S.roi ? "true" : "false");
  $("#guide").hidden = true;
  if (apply === "clear") S.roi = null;
  else if (apply && e && e.w > 0.05 && e.h > 0.05) S.roi = e;
  S.roiEdit = null; $("#btnArea").setAttribute("aria-pressed", S.roi ? "true" : "false");
  if (apply) { resetStability(); if (S.frozen) analyseStill(false); }
}
function showGuide(text, roi) {
  const g = $("#guide"); g.hidden = false; $("#guideTxt").textContent = text;
  g.querySelectorAll(".extra").forEach((n) => n.remove());
  const cancel = $("#guideCancel");
  if (roi) {
    const shape = el("button", { class: "extra", text: S.roiShape === "ellipse" ? "Ellipse" : "Rectangle", onclick: (ev) => { S.roiShape = S.roiShape === "rect" ? "ellipse" : "rect"; ev.target.textContent = S.roiShape === "ellipse" ? "Ellipse" : "Rectangle"; if (S.roiEdit) S.roiEdit.shape = S.roiShape; } });
    const done = el("button", { class: "extra", text: "Done", style: "background:var(--accent);color:var(--accent-ink)", onclick: () => endRoi(true) });
    const clr = el("button", { class: "extra", text: "Clear", onclick: () => endRoi("clear") });
    g.insertBefore(shape, cancel); g.insertBefore(clr, cancel); g.insertBefore(done, cancel); cancel.textContent = "✕"; cancel.setAttribute("aria-label", "Cancel");
    cancel.onclick = () => endRoi(false);
  } else { cancel.textContent = "Cancel"; cancel.onclick = () => { S.calibrating = null; g.hidden = true; if (S.frozen) { setHint(""); refreshFrozenUI(); } }; }
}

/* ============================== mode toggle ============================== */
function setMode(m, silent) {
  S.mode = m; persist();
  const seg = $("#modeSeg"), btns = seg.querySelectorAll("button[data-mode]");
  btns.forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m));
  const act = seg.querySelector(`[data-mode="${m}"]`), th = seg.querySelector(".thumb");
  th.style.width = act.offsetWidth + "px"; th.style.transform = `translateX(${act.offsetLeft - 3}px)`;
  if (!silent) { resetStability(); markers.forEach((x) => (x.dying = true)); if (S.frozen) analyseStill(false); }
}
$("#modeSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (b && b.dataset.mode !== S.mode) setMode(b.dataset.mode); });

/* ============================== toast / hint / modal ============================== */
let toastT;
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms); }
function setHint(txt) { const h = $("#hint"); h.hidden = !txt; h.textContent = txt || ""; }
function updateHint() {
  if (S.frozen) return;
  if (!S.res) return setHint("");
  setHint(S.res.total === 0 ? (S.mode === "tray" ? "Frame the whole tray in view" : "Point the camera at the pills") : "");
}
function openModal(node) { const w = $("#modalWrap"), m = $("#modal"); m.textContent = ""; m.append(node); w.hidden = false; }
function closeModal() { $("#modalWrap").hidden = true; }
$("#modalWrap").addEventListener("click", (e) => { if (e.target.id === "modalWrap") closeModal(); });

/* ============================== calibration ============================== */
const REFS = [{ key: "quarter", label: "US quarter", mm: 24.26 }, { key: "penny", label: "US penny", mm: 19.05 }];
function openCalibrate() {
  let sel = "quarter"; const inp = el("input", { type: "number", inputmode: "decimal", step: "0.1", min: "1", placeholder: "mm", class: "numinp", style: "width:90px;height:40px;border-radius:10px;border:0;background:var(--chip);padding:0 10px;font-size:16px;margin-left:auto;-webkit-user-select:text;user-select:text" });
  const opts = [];
  const mk = (key, label, small) => { const b = el("button", { class: "opt" + (key === sel ? " sel" : ""), onclick: () => { sel = key; opts.forEach((o) => o.el.classList.toggle("sel", o.key === sel)); } }, label, small); opts.push({ key, el: b }); return b; };
  const node = el("div", null,
    el("h2", { text: "Calibrate size" }),
    el("p", { text: S.mmPerNorm ? `Calibrated with ${S.calLabel}. Keep the phone at the same height for sizes to stay accurate.` : "Place a coin or a pill of known length on the tray. Then tap it in a frozen photo to measure size in millimetres." }),
    mk("quarter", "US quarter", el("small", { text: "24.26 mm" })), mk("penny", "US penny", el("small", { text: "19.05 mm" })),
    mk("pill", "Known pill length", inp),
    el("div", { class: "row" },
      S.mmPerNorm ? el("button", { class: "btn", text: "Clear", onclick: () => { S.mmPerNorm = null; S.calLabel = ""; persist(); closeModal(); toast("Calibration cleared"); scheduleId(true); } }) : null,
      el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
      el("button", { class: "btn pri", text: "Continue", onclick: async () => {
        let ref;
        if (sel === "pill") { const mm = parseFloat(inp.value); if (!(mm > 1 && mm < 100)) { inp.focus(); return toast("Enter the pill length in mm"); } ref = { label: "pill", mm }; }
        else ref = REFS.find((r) => r.key === sel);
        closeModal(); S.calibrating = { label: ref.label, mm: ref.mm };
        if (S.frozen) { showGuide(`Tap the ${ref.label} in the photo`); renderHUD(frozenDisplay()); }
        else if (S.source) await capture();
      } })));
  openModal(node);
}
function calibrateAt(x, y) {
  const res = S.res; let best = -1, bd = 1e9;
  res.pills.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y) / Math.max(p.a, p.b); if (d < bd) { bd = d; best = i; } });
  if (best < 0 || bd > 1.8) return toast("Tap closer to the reference object");
  const p = res.pills[best], major = 2 * Math.max(p.a, p.b), ref = S.calibrating;
  S.mmPerNorm = (ref.mm * Math.max(S.imgW, S.imgH)) / major; S.calLabel = ref.label; persist();
  S.calibrating = null; $("#guide").hidden = true;
  toast(`Calibrated: ${(ref.mm / major).toFixed(3)} mm per pixel. Remove the ${ref.label} before counting.`, 4200);
  analyseStill(false);
}
$("#btnCal").addEventListener("click", openCalibrate);
$("#btnArea").addEventListener("click", startRoi);
$("#btnTorch").addEventListener("click", toggleTorch);

/* ============================== history ============================== */
function saveHistory(isNew) {
  if (!S.res) return; const d = frozenDisplay(); const list = store.get("pc.history", []);
  const entry = { t: Date.now(), total: d.count, lo: d.range[0], hi: d.range[1], drug: S.lock ? S.lock.row.name + (S.lock.row.strength ? " " + S.lock.row.strength : "") : null, adj: d.adj, label: d.label, tgt: PCX.target || null, ver: PCX.verify ? PCX.verify.state : null };
  if (isNew || S.histIdx < 0) { entry.thumb = pcxThumb(S.stillFrame); list.unshift(entry); S.histIdx = 0; }
  else { const o = list[0] || {}; list[0] = { ...entry, t: o.t || entry.t, thumb: o.thumb || pcxThumb(S.stillFrame), rec: o.rec }; }
  if (!pcxSaveHist(list.slice(0, 30))) toast("Storage full: history could not be saved");
}
function openHistory() {
  const list = store.get("pc.history", []);
  const body = list.length ? list.map((h) => el("div", { class: "hist" }, h.thumb ? el("img", { class: "thumb", src: h.thumb, alt: "" }) : null, el("b", { text: h.total }),
    el("div", null, el("div", { text: h.drug || "Unspecified drug", style: "font-weight:600" }), el("span", { text: (h.label || "") + (h.tgt ? ` · of ${h.tgt}` : "") + (h.ver === "ok" ? " · Verified ×2" : h.ver === "diff" ? " · recount differed" : "") + (h.rec ? " · record saved" : "") })),
    el("div", { class: "r" }, el("span", { text: new Date(h.t).toLocaleDateString([], { month: "short", day: "numeric" }) }), el("br"), el("span", { text: new Date(h.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })))) : [el("div", { class: "empty", text: "No counts yet. Captured counts appear here." })];
  openModal(el("div", null, el("h2", { text: "Recent counts" }), el("p", { text: "Saved on this phone only." }), ...body,
    el("div", { class: "row" }, list.length ? el("button", { class: "btn", text: "Clear", onclick: () => { pcxSaveHist([]); openHistory(); } }) : null, el("button", { class: "btn pri", text: "Done", onclick: closeModal }))));
}
$("#btnHist").addEventListener("click", () => (PCI.on ? pciOpenHistory() : openHistory()));

/* ============================== identification panel ============================== */
function drawPillIcon(canvas, o, size = 48) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3); canvas.width = size * dpr; canvas.height = size * dpr; canvas.style.width = canvas.style.height = size + "px";
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size, size);
  const cols = (o.cssColors && o.cssColors.length ? o.cssColors : [o.fill || "#ddd"]); const c0 = cols[0], c1 = cols[1] || null;
  const shape = o.shape || "round", cx = size / 2, cy = size / 2;
  g.save(); g.translate(cx, cy); if (shape === "capsule" || shape === "oval") g.rotate(-Math.PI / 5);
  let A = size * 0.38, B = size * 0.38;
  if (shape === "oval") { A = size * 0.42; B = size * 0.28; } if (shape === "capsule") { A = size * 0.44; B = size * 0.21; }
  const path = () => {
    g.beginPath();
    if (shape === "capsule") { g.moveTo(-A + B, -B); g.arcTo(A, -B, A, B, B); g.arcTo(A, B, -A, B, B); g.arcTo(-A, B, -A, -B, B); g.arcTo(-A, -B, A, -B, B); g.closePath(); }
    else if (shape === "four-sided") { rr(g, -A * 0.85, -B * 0.85, A * 1.7, B * 1.7, size * 0.07); }
    else if (shape === "triangle") { g.moveTo(0, -A * 0.95); g.lineTo(A * 0.9, A * 0.65); g.lineTo(-A * 0.9, A * 0.65); g.closePath(); }
    else g.ellipse(0, 0, A, B, 0, 0, Math.PI * 2);
  };
  g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 5; g.shadowOffsetY = 2;
  path(); g.fillStyle = c0; g.fill(); g.shadowColor = "transparent";
  if (c1) { g.save(); path(); g.clip(); g.fillStyle = c1; g.fillRect(0, -size, size, size * 2); g.restore(); }
  path(); const sh = g.createRadialGradient(-A * 0.3, -B * 0.4, 1, 0, 0, Math.max(A, B) * 1.1); sh.addColorStop(0, "rgba(255,255,255,.55)"); sh.addColorStop(0.5, "rgba(255,255,255,0)"); sh.addColorStop(1, "rgba(0,0,0,.22)");
  g.fillStyle = sh; g.fill(); g.lineWidth = 1; g.strokeStyle = "rgba(0,0,0,.35)"; g.stroke();
  if (shape !== "round" && shape !== "triangle" && !c1) { g.beginPath(); g.moveTo(0, -B * 0.9); g.lineTo(0, B * 0.9); g.strokeStyle = "rgba(0,0,0,.12)"; g.stroke(); }
  g.restore();
}
const iconForGroup = (g) => ({ shape: g.shape, cssColors: g.halvesRgb ? g.halvesRgb.map(rgbCss) : (g.colors && g.colors.length > 1 ? g.colors.map(colorHex) : [g.rgb ? rgbCss(g.rgb) : colorHex(g.colors && g.colors[0])]) });
const iconForRow = (r) => ({ shape: r.shape, cssColors: (r.colors || []).slice(0, 2).map(colorHex) });
const body = $("#sheetBody");
let idTimer = 0, idBusy = false;
function scheduleId(now) {
  if (idTimer && !now) return;
  clearTimeout(idTimer); idTimer = setTimeout(async () => { idTimer = 0; await refreshId(); }, now ? 30 : 900);
}
function groupKey(g) {
  if (!g) return "none";
  const mm = nbaMmNorm() ? Math.round(nbaMmNorm() * 100) : 0;
  return [g.colors && g.colors.join("/"), g.shape, g.twoTone, g.lengthMm ? Math.round(g.lengthMm) : "", mm, S.imprint, S.lock ? S.lock.row.name : ""].join("|");
}
async function refreshId() {
  if (idBusy) return scheduleId(); const g = primaryGroup(S.res);
  const key = groupKey(g) + "|" + (S.res ? S.res.groups.length : 0) + "|" + S.frozen;
  if (key === S.idKey) { renderPeek(g); return; }
  S.idKey = key; idBusy = true;
  try {
    const m = await loadId();
    const mm = nbaMmNorm() ? nbaMmNorm() / Math.max(S.imgW, S.imgH) : undefined;
    S.idRows = g ? m.identify(g, { mmPerPx: mm, imprint: S.imprint || undefined, limit: 8 }) || [] : [];
    S.idMatches = S.imprint && m.searchImprint ? m.searchImprint(S.imprint, { limit: 6 }) || [] : [];
  } catch (e) { S.idRows = []; S.idMatches = []; }
  idBusy = false; renderPeek(g); renderSheet(g);
}
function renderPeek(g) {
  const ic = $("#peekIcon");
  if (!g) { drawPillIcon(ic, { shape: "round", cssColors: ["rgba(128,128,128,.3)"] }); $("#peekTitle").textContent = "Identify"; $("#peekSub").textContent = "Count pills to see matches"; return; }
  drawPillIcon(ic, iconForGroup(g));
  const best = S.lock ? S.lock.row : S.idRows[0];
  $("#peekTitle").textContent = best ? `${S.lock ? "Locked: " : "Likely: "}${best.name}${best.strength ? " " + best.strength : ""}` : pcDescribe(g);
  $("#peekSub").textContent = S.lock ? "Counting only this drug" : best ? "Confirm with the imprint — swipe up" : "Swipe up to identify";
}
function rowCard(r, i, kind) {
  const c = el("div", { class: "card" + (kind === "best" ? " best" : ""), style: `animation-delay:${Math.min(i, 8) * 40}ms` });
  const ic = el("canvas"); drawPillIcon(ic, iconForRow(r), 44);
  const sc = Math.round((r.score || 0) * 100);
  const locked = S.lock && S.lock.row.name === r.name && S.lock.row.strength === r.strength && S.lock.row.imprint === r.imprint;
  c.append(ic, el("div", { class: "ci" },
    el("div", { class: "nm" }, r.name, r.strength ? el("small", { text: "  " + r.strength }) : null),
    r.imprint ? el("div", { class: "im", text: "Imprint: " + r.imprint }) : null,
    el("div", { class: "meta", text: [(r.colors || []).join("/"), r.shape, r.sizeMm ? pcxLen(+r.sizeMm) : ""].filter(Boolean).join(" · ") }),
    r.labeler ? el("div", { class: "meta", text: r.labeler }) : null,
    r.reasons && r.reasons.length ? el("div", { class: "why", text: r.reasons.slice(0, 3).join(" · ") }) : null,
    el("div", { class: "score" }, el("span", { text: sc + "%", class: "num", style: "min-width:34px" }), el("div", { class: "bar" }, el("i", { style: `width:${sc}%;--c:${sc > 70 ? "var(--accent)" : sc > 40 ? "var(--accent-2)" : "var(--amber)"}` }))),
    el("button", { class: "lockbtn" + (locked ? " on" : kind === "best" ? "" : " ghost"), text: locked ? "✓ Counting only this — tap to unlock" : "Count only this drug", onclick: () => (locked ? unlockDrug() : lockDrug(r)) })));
  return c;
}
function renderSheet(g) {
  body.textContent = "";
  if (!g) { body.append(el("div", { class: "empty", text: "Point the camera at pills, or capture a photo, to see likely matches." })); return; }
  const mm = g.lengthMm || (nbaMmNorm() && g.lengthPx ? g.lengthPx * nbaMmNorm() / Math.max(S.imgW, S.imgH) : 0);
  const traits = el("div", { class: "traits" });
  (g.colors && g.colors.length ? g.colors : ["unknown"]).forEach((c, i) => traits.append(el("span", { class: "chip" }, el("i", { class: "sw", style: `background:${g.halvesRgb && g.halvesRgb[i] ? rgbCss(g.halvesRgb[i]) : colorHex(c)}` }), c)));
  if (g.twoTone) traits.append(el("span", { class: "chip", text: "two-tone" }));
  if (g.shape) traits.append(el("span", { class: "chip", text: g.shape }));
  traits.append(el("span", { class: "chip num", text: `${g.count} in group` }));
  traits.append(mm ? el("span", { class: "chip num", text: `${pcxLen(mm)} long` }) : nbaDepthUsed() ? el("span", { class: "chip", text: "Size from LiDAR" }) : el("button", { class: "chip link", text: "Size unknown — calibrate", onclick: () => { toggleSheet(false); openCalibrate(); } }));
  const head = el("div", { style: "display:flex;gap:12px;align-items:center;margin-bottom:8px" });
  const big = el("canvas"); drawPillIcon(big, iconForGroup(g), 64); head.append(big, el("div", null, el("div", { style: "font-size:19px;font-weight:700", text: "Detected: " + pcDescribe(g) }), el("div", { class: "meta", style: "color:var(--muted);font-size:13px", text: `${S.frozen ? "From captured photo" : "Live view"} · most common pill` })));
  const imp = el("input", { type: "text", placeholder: "Type imprint (e.g. M366)", autocapitalize: "characters", autocomplete: "off", autocorrect: "off", spellcheck: "false", value: S.imprint, "aria-label": "Imprint text" });
  imp.value = S.imprint;
  let t; imp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { S.imprint = imp.value.trim(); S.idKey = ""; refreshId().then(() => { const n = $("#sheetBody input"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }, 350); });
  const field = el("label", { class: "field" }, el("svg", { viewBox: "0 0 24 24" }), imp, S.imprint ? el("button", { "aria-label": "Clear imprint", text: "✕", onclick: (e) => { e.preventDefault(); S.imprint = ""; S.idKey = ""; refreshId(); } }) : null);
  field.querySelector("svg").innerHTML = '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>';
  body.append(head, traits,
    el("div", { class: "notice" }, el("span", { text: "⚠️" }), el("div", null, el("b", { text: "Confirm with the imprint — " }), "appearance alone can't identify a medication.")),
    field);
  if (S.lock) {
    body.append(el("h3", { class: "sec", text: "Locked drug" }), rowCard({ ...S.lock.row, reasons: ["Everything not matching is flagged"] }, 0, "best"));
  }
  const rows = S.idRows.filter((r) => !(S.lock && r.name === S.lock.row.name && r.strength === S.lock.row.strength && r.imprint === S.lock.row.imprint));
  if (S.imprint && S.idMatches.length) {
    body.append(el("h3", { class: "sec", text: `Imprint matches for “${S.imprint.toUpperCase()}”` }));
    S.idMatches.forEach((r, i) => body.append(rowCard(r, i, i === 0 && !rows.length ? "best" : "")));
  }
  if (rows.length) {
    body.append(el("h3", { class: "sec", text: S.lock ? "Other possibilities" : "Most likely" }));
    body.append(rowCard(rows[0], 0, S.lock ? "" : "best"));
    if (rows.length > 1) { body.append(el("h3", { class: "sec", text: "Look-alikes" })); rows.slice(1).forEach((r, i) => body.append(rowCard(r, i + 1, ""))); }
  } else if (!S.idMatches.length) body.append(el("div", { class: "empty", text: "No close matches found in the on-device database." }));
  
}
function lockDrug(row) {
  const g = primaryGroup(S.res); if (!g) return;
  S.lock = { row, sig: { colors: g.colors || [], shape: g.shape, rgb: g.rgb } };
  S.idKey = ""; resetStability(); toast(`Counting only ${row.name}`);
  if (S.frozen) { syncMarkers(S.res, true); refreshFrozenUI(); saveHistory(false); } else markers.forEach((m) => (m.dying = false));
  refreshId();
}
function unlockDrug() {
  S.lock = null; S.idKey = ""; resetStability(); bannerSig = "";
  if (S.frozen) { syncMarkers(S.res, true); refreshFrozenUI(); } refreshId();
}

/* ---- sheet drag / toggle ---- */
const sheet = $("#sheet"), head = $("#sheetHead");
function sheetMetrics() { const peek = head.offsetHeight; return { max: Math.max(0, sheet.offsetHeight - peek), peek }; }
function toggleSheet(open) {
  S.sheetOpen = open == null ? !S.sheetOpen : open; sheet.style.transform = ""; document.body.classList.toggle("sheet-open", S.sheetOpen);
  if (S.sheetOpen) scheduleId(true);
}
let sd = null;
head.addEventListener("pointerdown", (e) => { const m = sheetMetrics(); sd = { y0: e.clientY, base: S.sheetOpen ? 0 : m.max, max: m.max, moved: false, t: performance.now(), y: e.clientY }; head.setPointerCapture(e.pointerId); });
head.addEventListener("pointermove", (e) => {
  if (!sd) return; const dy = e.clientY - sd.y0; if (Math.abs(dy) > 5) { sd.moved = true; sheet.classList.add("drag"); }
  sd.y = e.clientY; if (sd.moved) sheet.style.transform = `translateY(${pcClamp(sd.base + dy, 0, sd.max)}px)`;
});
function endSheetDrag(e) {
  if (!sd) return; const d = sd; sd = null; sheet.classList.remove("drag");
  if (!d.moved) return toggleSheet();
  const dy = d.y - d.y0, v = dy / Math.max(1, performance.now() - d.t); const pos = pcClamp(d.base + dy, 0, d.max);
  toggleSheet(Math.abs(v) > 0.4 ? v < 0 : pos < d.max / 2);
}
head.addEventListener("pointerup", endSheetDrag); head.addEventListener("pointercancel", endSheetDrag);

/* ============================== fallback screen ============================== */
function showFallback(title, msg, why) {
  $("#fbTitle").textContent = title; $("#fbMsg").textContent = msg; $("#fbWhy").textContent = why || "";
  $("#fallback").hidden = false;
}
async function onPhoto(file) {
  if (!file) return;
  if (PCI.on) pciSetAppMode("count");
  try {
    const c = await fileToCanvas(file, 2048);
    S.source = { kind: "photo", el: c, dims: () => [c.width, c.height], min: 0 };
    S.fit = "contain"; app.dataset.src = ""; S.frozen = false; S.busy = false;
    $("#fallback").hidden = true; resetStability();
    freezeWith(c); await analyseStill(true);
  } catch (e) { toast("Could not open that photo"); }
}
$("#fileCam").addEventListener("change", (e) => { onPhoto(e.target.files[0]); e.target.value = ""; });
$("#fileLib").addEventListener("change", (e) => { onPhoto(e.target.files[0]); e.target.value = ""; });
$("#fbRetry").addEventListener("click", () => boot());
$("#shutter").addEventListener("click", capture);
$("#retake").addEventListener("click", retake);
document.addEventListener("visibilitychange", () => { if (!document.hidden && video.srcObject && video.paused) video.play().catch(() => {}); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); toggleSheet(false); } if (e.key === " " && e.target === document.body && !PCI.on) { e.preventDefault(); S.frozen ? retake() : capture(); } });

/* ============================== extras: target, tally, groups, voice, record, recount, settings ============================== */
const PCX = {
  o: Object.assign({ voice: false, sound: true, groups: false, wake: false, units: "mm", contrast: false, auto: false, burst: true }, store.get("pc.opts", {})),
  target: (() => { const t = store.get("pc.target", null); return t > 0 ? t | 0 : null; })(),
  tally: (store.get("pc.tally", []) || []).filter((n) => n > 0).map((n) => n | 0),
  groupsOn: false, hit: false, lastD: null, autoAt: 0, audio: null, touched: false, wl: null, verify: null, ann: "", gKey: "", gData: null, gRes: null,
  palDef: null,
};
PCX.groupsOn = !!PCX.o.groups;
const pcxSaveOpts = () => store.set("pc.opts", PCX.o);
const pcxTallySum = () => PCX.tally.reduce((a, b) => a + b, 0);
const pcxLen = (mm) => (PCX.o.units === "in" ? (mm / 25.4).toFixed(2) + " in" : mm.toFixed(1) + " mm");
function pcxRefresh() { try { renderHUD(S.frozen && S.res ? frozenDisplay() : computeDisplay()); } catch {} }

/* ---- sound / speech / haptics ---- */
document.addEventListener("pointerdown", () => {
  PCX.touched = true;
  try { if (!PCX.audio) { const C = window.AudioContext || window.webkitAudioContext; if (C) PCX.audio = new C(); } if (PCX.audio && PCX.audio.state === "suspended") PCX.audio.resume().catch(() => {}); } catch {}
}, { capture: true });
function pcxBeep(kind) {
  if (!PCX.o.sound || !PCX.touched || !PCX.audio) return;
  try {
    const a = PCX.audio, t = a.currentTime;
    for (const [f, dt] of kind === "done" ? [[784, 0], [1175, 0.09]] : [[1320, 0]]) {
      const o = a.createOscillator(), g = a.createGain(); o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.07, t + dt + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.09);
      o.connect(g); g.connect(a.destination); o.start(t + dt); o.stop(t + dt + 0.11);
    }
  } catch {}
}
function pcxSay(text) {
  if (!PCX.o.voice || !PCX.touched || !("speechSynthesis" in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.speak(u); } catch {}
}
function pcxBuzz(p) { try { if (PCX.touched && navigator.vibrate) navigator.vibrate(p); } catch {} }
async function pcxWake(loud) {
  try {
    if (PCX.o.wake) {
      if (!("wakeLock" in navigator)) throw new Error("none");
      if (!PCX.wl) { PCX.wl = await navigator.wakeLock.request("screen"); PCX.wl.addEventListener("release", () => { PCX.wl = null; }); }
    } else if (PCX.wl) { await PCX.wl.release(); PCX.wl = null; }
  } catch { PCX.wl = null; if (loud && PCX.o.wake) toast("Keep-awake isn't available on this device"); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && PCX.o.wake && !PCX.wl) pcxWake(false); });
function pcxApplyOpts() {
  if (!PCX.palDef) PCX.palDef = { ...PAL };
  Object.assign(PAL, PCX.palDef, PCX.o.contrast ? { ok: "#00ffd0", med: "#ffffff", low: "#ffe600", odd: "#ff2d55", frag: "#ff9500" } : {});
  $("#chipG5").setAttribute("aria-pressed", PCX.groupsOn);
}

/* ---- target quantity: HUD ring + states + success ---- */
const pcxClampPct = (x) => (isFinite(x) ? pcClamp(x, 0, 1) : 0);
function pcxGoal(d) {
  PCX.lastD = d;
  const t = PCX.target, tally = pcxTallySum(), total = d.count + tally;
  const goal = $("#goal"), rw = $("#ringWrap"), v = $("#verify");
  $("#chipQtyV").textContent = t ? String(t) : "set";
  if (!t) { goal.hidden = true; rw.hidden = true; PCX.hit = false; }
  else {
    const diff = t - total, pct = pcxClampPct(total / t);
    const exact = diff === 0 && d.count > 0 && ((d.locked && d.conf >= 0.85) || (S.frozen && (d.conf >= 0.8 || d.adj)));
    const cls = diff === 0 ? "ok" : diff > 0 ? "add" : "rem";
    const tx = diff === 0 ? (exact ? `✓ ${t} exactly` : `At ${t}, confirming…`) : diff > 0 ? `Add ${diff}` : `Remove ${-diff}`;
    goal.hidden = false; goal.className = "goal " + cls; goal.textContent = tx + (tally ? ` · tally ${tally}` : "");
    rw.hidden = false;
    const prg = $("#ringPrg"); prg.style.strokeDashoffset = String(138.2 * (1 - pct));
    prg.style.setProperty("--rc", diff === 0 ? "var(--accent)" : diff > 0 ? "var(--amber)" : "var(--alert)");
    $("#ringTxt").textContent = diff < 0 ? "+" + (-diff) : Math.round(pct * 100) + "%";
    if (exact && !PCX.hit) { PCX.hit = true; pcxSuccess(total); }
    else if (diff !== 0) PCX.hit = false;
  }
  if (S.frozen && PCX.verify) {
    v.hidden = false; v.className = "verify " + PCX.verify.state;
    v.textContent = PCX.verify.state === "ok" ? "✓✓ Verified ×2" : `≠ Recount ${PCX.verify.now} vs ${PCX.verify.prev}`;
  } else v.hidden = true;
  const key = (S.frozen ? "c" : "l") + total + "|" + (t ? t - total : "");
  if (d.locked || S.frozen) {
    if (key !== PCX.ann) { PCX.ann = key; a11y(`${S.frozen ? "Captured" : "Locked"} ${d.count}` + (t ? `. ${t === total ? "Matches target " + t : t > total ? "Add " + (t - total) : "Remove " + (total - t)}` : "")); }
  } else PCX.ann = "";
  pcxRenderChips();
}
function pcxSuccess(total) {
  pcxBeep("done"); pcxBuzz([40, 50, 40, 50, 90]); pcxSay(`${total}. Target reached`);
  if (RM) return;
  hud.classList.remove("hit"); void hud.offsetWidth; hud.classList.add("hit"); setTimeout(() => hud.classList.remove("hit"), 950);
  const b = $("#burst"); b.textContent = "";
  for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2, r = 34 + (i % 3) * 10; b.append(el("i", { style: `--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r}px;background:${i % 2 ? "var(--accent)" : "#fff"}` })); }
  setTimeout(() => { b.textContent = ""; }, 900);
}
function pcxOpenQty() {
  let v = PCX.target ? String(PCX.target) : "";
  const disp = el("div", { class: "padv", "aria-live": "polite" });
  const upd = () => { disp.textContent = v || "0"; };
  const done = (n) => { PCX.target = n > 0 ? n : null; store.set("pc.target", PCX.target); PCX.hit = false; closeModal(); pcxRefresh(); if (n > 0) toast(`Target set to ${n}`); };
  const key = (k) => el("button", { text: k, "aria-label": k === "⌫" ? "Delete" : k, onclick: () => { if (k === "⌫") v = v.slice(0, -1); else if (v.length < 4) v = (v + k).replace(/^0+/, ""); upd(); } });
  const presets = el("div", { class: "presets" }, [7, 14, 28, 30, 60, 90, 120].map((n) => el("button", { text: n, class: PCX.target === n ? "on" : "", onclick: () => done(n) })));
  upd();
  openModal(el("div", null, el("h2", { text: "Target quantity" }), el("p", { text: "Prescription fill quantity. Tap a preset, or type any number." }), disp, presets,
    el("div", { class: "pad" }, ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(key), el("button", { text: "Clear", style: "font-size:1rem", onclick: () => { v = ""; upd(); } }), key("0"), key("⌫")),
    el("div", { class: "row" }, PCX.target ? el("button", { class: "btn", text: "Remove target", onclick: () => done(0) }) : el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
      el("button", { class: "btn pri", text: "Set", onclick: () => done(parseInt(v, 10) || 0) }))));
}

/* ---- batch tally ---- */
function pcxSaveTally() { store.set("pc.tally", PCX.tally); }
function pcxRenderChips() {
  const ct = $("#chipTally"), cu = $("#chipUndo"), n = PCX.tally.length;
  ct.hidden = cu.hidden = !n;
  if (n) {
    const shown = n > 4 ? "… + " + PCX.tally.slice(-3).join(" + ") : PCX.tally.join(" + ");
    ct.textContent = `Tally ${shown} = ${pcxTallySum()}`;
  }
}
function pcxAddTally() {
  let c;
  if (S.frozen && S.res) { if (S.busy || S.calibrating) return; c = frozenDisplay().count; }
  else {
    if (!S.source) return;
    const d = computeDisplay();
    if (!d.locked) return toast("Hold steady until the count locks, then add it");
    c = d.count;
  }
  if (!(c > 0)) return toast("Nothing counted yet");
  PCX.tally.push(c); pcxSaveTally(); pcxBeep(); pcxBuzz(15);
  toast(`Added ${c} · tally ${PCX.tally.join(" + ")} = ${pcxTallySum()}`);
  PCX.hit = false;
  if (S.frozen) retake(); else resetStability();
  pcxRefresh();
}
function pcxUndoTally() { if (!PCX.tally.length) return; const n = PCX.tally.pop(); pcxSaveTally(); PCX.hit = false; toast(`Removed batch of ${n}`); pcxRefresh(); }
function pcxOpenTally() {
  let armed = false;
  const body = () => {
    const n = PCX.tally.length;
    return el("div", null, el("h2", { text: n ? `Tally ${pcxTallySum()}` : "Tally" }), el("p", { text: "Count several trays, tap “＋ Tally” after each one, and the running total builds here." }),
      ...(n ? PCX.tally.map((v, i) => el("div", { class: "batch" }, el("span", { text: `Batch ${i + 1}` }), el("b", { text: v }))) : [el("div", { class: "empty", text: "No batches yet" })]),
      el("div", { class: "row" }, n ? el("button", { class: "btn", text: "Undo last", onclick: () => { pcxUndoTally(); openModal(body()); } }) : null,
        n ? el("button", { class: "btn", text: armed ? "Tap again to clear" : "Clear", onclick: () => { if (!armed) { armed = true; openModal(body()); return; } PCX.tally = []; pcxSaveTally(); PCX.hit = false; closeModal(); pcxRefresh(); } }) : null,
        el("button", { class: "btn pri", text: "Done", onclick: closeModal })));
  };
  openModal(body());
}

/* ---- groups of five ---- */
function pcxPts() {
  const res = S.res, out = [];
  res.pills.forEach((p, i) => { if (S.corr.removed.has(i) || isFlagged(res.groups[p.group])) return; out.push({ x: p.x, y: p.y, a: p.a, b: p.b, th: p.theta || 0 }); });
  S.corr.adds.forEach((q) => out.push({ x: q.x, y: q.y, a: q.r, b: q.r, th: 0 }));
  return out;
}
function pcxCluster(pts) {
  const rowH = (pcMedian(pts.map((p) => Math.round(Math.min(p.a, p.b)))) || 20) * 1.6;
  const order = pts.map((_, i) => i).sort((i, j) => Math.round(pts[i].y / rowH) - Math.round(pts[j].y / rowH) || pts[i].x - pts[j].x);
  const used = new Set(), groups = [];
  for (const s0 of order) {
    if (used.has(s0)) continue; const g = [s0]; used.add(s0);
    while (g.length < 5) {
      const cx = g.reduce((a, i) => a + pts[i].x, 0) / g.length, cy = g.reduce((a, i) => a + pts[i].y, 0) / g.length;
      let best = -1, bd = 1e18;
      for (const j of order) { if (used.has(j)) continue; const dd = Math.hypot(pts[j].x - cx, pts[j].y - cy); if (dd < bd) { bd = dd; best = j; } }
      if (best < 0) break; g.push(best); used.add(best);
    }
    groups.push(g);
  }
  return groups;
}
function pcxHull(P) {
  if (P.length < 3) return P;
  P = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = []; for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = []; for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); return lo.concat(up);
}
function pcxGroupsFor() {
  const key = [S.res && S.res.total, [...S.corr.removed].join(","), S.corr.adds.length, S.lock ? S.lock.row.name : "", S.imgW].join("|");
  if (PCX.gData && PCX.gKey === key && PCX.gRes === S.res) return PCX.gData;
  const pts = pcxPts(); PCX.gKey = key; PCX.gRes = S.res; PCX.gData = { pts, groups: pcxCluster(pts) }; return PCX.gData;
}
function pcxDrawGroups(V) {
  const { pts, groups } = pcxGroupsFor(); const hi = PCX.o.contrast;
  groups.forEach((g, k) => {
    const hue = (k * 137.5 + 20) % 360, full = g.length === 5;
    const P = [];
    for (const i of g) { const p = pts[i]; for (let q = 0; q < 10; q++) { const f = (q / 10) * Math.PI * 2, u = Math.cos(f) * p.a, w = Math.sin(f) * p.b; P.push([V.ox + (p.x + u * Math.cos(p.th) - w * Math.sin(p.th)) * V.s, V.oy + (p.y + u * Math.sin(p.th) + w * Math.cos(p.th)) * V.s]); } }
    const H = pcxHull(P); if (H.length < 2) return;
    ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.beginPath(); H.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath();
    ctx.fillStyle = `hsla(${hue},90%,62%,${hi ? 0.3 : 0.17})`; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 16; ctx.stroke(); ctx.fill();
    ctx.setLineDash(full ? [] : [6, 5]); ctx.strokeStyle = `hsla(${hue},95%,75%,${hi ? 1 : 0.8})`; ctx.lineWidth = hi ? 3 : 1.6; ctx.stroke(); ctx.restore();
    let top = H[0]; for (const q of H) if (q[1] < top[1]) top = q;
    chip(ctx, full ? String(k + 1) : `${k + 1} · ${g.length}`, top[0], top[1] - 16, `hsl(${hue},60%,32%)`, "#fff");
  });
}

/* ---- recount (double-count check) ---- */
async function pcxRecount() {
  if (!S.frozen || S.busy || !S.res || S.calibrating || !S.source || S.source.kind === "photo") return;
  const prevCount = frozenDisplay().count, N = Math.max(S.imgW, S.imgH);
  const prev = pcxPts().map((p) => ({ x: p.x / N, y: p.y / N, r: Math.min(p.a, p.b) / N }));
  S.busy = true; app.classList.add("busy"); PCX.verify = null; PCX.hit = false;
  try { if (S.inflight) await S.inflight.catch(() => {}); } catch {}
  try { if (S.source.tick) S.source.tick(); const f = await grabHi(); freezeWith(f.canvas); } catch { S.busy = false; app.classList.remove("busy"); return toast("Could not recapture"); }
  await analyseStill(false);
  const now = frozenDisplay().count, N2 = Math.max(S.imgW, S.imgH), cur = pcxPts();
  const diffNew = cur.map((p) => ({ x: p.x, y: p.y, r: Math.min(p.a, p.b) })).filter((p) => !prev.some((q) => Math.hypot(q.x * N2 - p.x, q.y * N2 - p.y) < Math.max(p.r, q.r * N2) * 1.3));
  const diffOld = prev.map((p) => ({ x: p.x * N2, y: p.y * N2, r: p.r * N2 })).filter((p) => !cur.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < Math.max(p.r, Math.min(q.a, q.b)) * 1.3));
  PCX.verify = now === prevCount ? { state: "ok", now, prev: prevCount } : { state: "diff", now, prev: prevCount, diffNew, diffOld };
  if (PCX.verify.state === "ok") { toast("Verified ×2: both counts agree"); pcxSay(`Verified. ${now}`); pcxBeep("done"); pcxBuzz([30, 40, 30]); }
  else { toast(`Counts differ: ${prevCount} then ${now}. Differences highlighted`, 4200); pcxSay(`Counts differ. ${prevCount} then ${now}`); pcxBuzz([80, 60, 80]); }
  saveHistory(false); refreshFrozenUI();
}
function pcxDrawDiff(V, t) {
  const vf = PCX.verify; const pulse = RM ? 0.5 : (Math.sin(t * 5) + 1) / 2;
  ctx.save(); ctx.lineWidth = 3.5; ctx.strokeStyle = "#ffb42e";
  for (const p of vf.diffNew) { const x = V.ox + p.x * V.s, y = V.oy + p.y * V.s, r = p.r * V.s * 1.5 + 6 + pulse * 5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
  for (const p of vf.diffOld) { const x = V.ox + p.x * V.s, y = V.oy + p.y * V.s, r = p.r * V.s * 1.5 + 6 + pulse * 5; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  ctx.restore();
  for (const p of vf.diffNew) chip(ctx, "2nd count only", V.ox + p.x * V.s, V.oy + p.y * V.s - p.r * V.s * 1.5 - 18, "rgba(120,80,0,.9)", "#ffd36b");
  for (const p of vf.diffOld) chip(ctx, "1st count only", V.ox + p.x * V.s, V.oy + p.y * V.s - p.r * V.s * 1.5 - 18, "rgba(120,80,0,.9)", "#ffd36b");
}

/* ---- history thumbnails / storage ---- */
function pcxThumb(c, w = 96, sh) {
  try { const hh = sh || c.height, o = document.createElement("canvas"); o.width = w; o.height = Math.max(1, Math.round(w * hh / c.width)); o.getContext("2d").drawImage(c, 0, 0, c.width, hh, 0, 0, o.width, o.height); return o.toDataURL("image/jpeg", 0.6); } catch { return ""; }
}
function pcxSaveHist(list) {
  const put = (l) => { try { localStorage.setItem("pc.history", JSON.stringify(l)); return true; } catch { return false; } };
  if (put(list)) return true;
  const l = list.map((e) => ({ ...e }));
  for (let i = l.length - 1; i >= 0; i--) if (l[i].thumb) { delete l[i].thumb; if (put(l)) return true; }
  while (l.length > 1) { l.pop(); if (put(l)) return true; }
  return false;
}

/* ---- count record image ---- */
async function pcxRecord() {
  if (!S.frozen || !S.res || S.busy || !S.stillFrame) return;
  const res = S.res, d = frozenDisplay(), src = S.stillFrame, W = 1080;
  const sc = Math.min(W / src.width, 1100 / src.height), pw = Math.round(src.width * sc), ph = Math.round(src.height * sc), px = Math.round((W - pw) / 2);
  const fl = flaggedInfo(res, S.corr.removed), tally = pcxTallySum(), t = PCX.target, total = d.count + tally;
  const notes = [];
  if (S.lock) notes.push(`Locked drug: ${S.lock.row.name}${S.lock.row.strength ? " " + S.lock.row.strength : ""}`);
  else if (S.idRows[0]) notes.push(`Likely: ${S.idRows[0].name}${S.idRows[0].strength ? " " + S.idRows[0].strength : ""} (unconfirmed)`);
  if (fl.n) notes.push(`${fl.n} different pill${fl.n > 1 ? "s" : ""} found: ${fl.groups.map(pcDescribe).join(" + ")}`);
  if (res.fragments.length) notes.push(`${res.fragments.length} broken piece${res.fragments.length > 1 ? "s" : ""} not counted`);
  if (d.adj) notes.push(`Manual adjust: ${[S.corr.adds.length ? "+" + S.corr.adds.length : "", S.corr.removed.size ? "−" + S.corr.removed.size : ""].filter(Boolean).join(" ")}`);
  if (PCX.verify) notes.push(PCX.verify.state === "ok" ? "Verified ×2 (two independent counts agree)" : `Recount differed: ${PCX.verify.prev} then ${PCX.verify.now}`);
  if (tally) notes.push(`Tally ${PCX.tally.join(" + ")} + this tray ${d.count} = ${total}`);
  notes.push(`Confidence ${Math.round(d.conf * 100)}% (${d.label})`);
  notes.push(new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  const panelH = 250 + notes.length * 44, c = document.createElement("canvas"); c.width = W; c.height = ph + panelH; const g = c.getContext("2d");
  g.fillStyle = "#06090c"; g.fillRect(0, 0, W, c.height); g.drawImage(src, px, 0, pw, ph);
  const idx = new Map(markers.filter((m) => m.kind === "pill" && !m.dying).map((m) => [m.i, m.idx]));
  const col = { ok: "#19d3c5", med: "#7fe9df", low: "#ffc233", odd: "#ff4d5e", frag: "#ff8f3d" };
  g.lineJoin = "round";
  res.fragments.forEach((f) => { g.save(); g.translate(px + f.x * sc, f.y * sc); g.rotate(f.theta || 0); g.setLineDash([3, 6]); g.strokeStyle = col.frag; g.lineWidth = 4; g.beginPath(); g.ellipse(0, 0, f.a * sc + 4, f.b * sc + 4, 0, 0, 7); g.stroke(); g.restore(); });
  res.pills.forEach((p, i) => {
    const removed = S.corr.removed.has(i), st = removed ? "x" : statusOf(res, p); g.save(); g.translate(px + p.x * sc, p.y * sc); g.rotate(p.theta || 0);
    g.beginPath(); g.ellipse(0, 0, p.a * sc + 2, p.b * sc + 2, 0, 0, 7); g.fillStyle = (st === "x" ? "#9aa0a6" : col[st]) + "33"; g.fill();
    g.strokeStyle = "rgba(0,0,0,.55)"; g.lineWidth = 6; g.stroke(); g.strokeStyle = st === "x" ? "#9aa0a6" : col[st]; g.lineWidth = 3.4; if (st === "low" || st === "x") g.setLineDash([8, 6]); g.stroke(); g.restore();
    g.save(); g.translate(px + p.x * sc, p.y * sc); g.textAlign = "center"; g.textBaseline = "middle";
    if (removed) { const r = Math.min(p.a, p.b) * sc * 0.55; g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath(); g.moveTo(-r, -r); g.lineTo(r, r); g.moveTo(r, -r); g.lineTo(-r, r); g.stroke(); }
    else if (idx.get(i)) { g.font = `700 ${pcClamp(Math.min(p.a, p.b) * sc * 0.95, 11, 26)}px -apple-system, system-ui, sans-serif`; g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,.7)"; g.strokeText(idx.get(i), 0, 1); g.fillStyle = "#fff"; g.fillText(idx.get(i), 0, 1); }
    g.restore();
  });
  S.corr.adds.forEach((a) => { g.save(); g.translate(px + a.x * sc, a.y * sc); g.strokeStyle = "#fff"; g.lineWidth = 3.4; g.beginPath(); g.arc(0, 0, a.r * sc + 2, 0, 7); g.stroke(); const q = a.r * sc * 0.45; g.beginPath(); g.moveTo(-q, 0); g.lineTo(q, 0); g.moveTo(0, -q); g.lineTo(0, q); g.stroke(); g.restore(); });
  const y0 = ph + 20, F = "-apple-system, system-ui, sans-serif"; g.textBaseline = "alphabetic"; g.textAlign = "left";
  g.fillStyle = "#f4f7f9"; g.font = `800 150px ${F}`; g.fillText(String(d.count), 40, y0 + 130);
  const bx = 40 + g.measureText(String(d.count)).width + 30; g.font = `700 40px ${F}`;
  const status = t ? (total === t ? "✓ Matches target" : total < t ? `Short by ${t - total}` : `Over by ${total - t}`) : "pills counted";
  g.fillStyle = t ? (total === t ? "#19d3c5" : total < t ? "#ffb42e" : "#ff4d5e") : "rgba(244,247,249,.75)"; g.fillText(status, bx, y0 + 72);
  g.fillStyle = "rgba(244,247,249,.7)"; g.font = `500 32px ${F}`; g.fillText(t ? `Target ${t}` : "No target set", bx, y0 + 118);
  g.font = `500 32px ${F}`; notes.forEach((n, i) => { g.fillStyle = /different|differed|Short|Over/.test(n) ? "#ff8f8f" : "rgba(244,247,249,.82)"; g.fillText(n.length > 60 ? n.slice(0, 58) + "…" : n, 40, y0 + 200 + i * 44); });
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) return toast("Could not create the record");
  try { const list = store.get("pc.history", []); if (list[0]) { list[0].rec = true; list[0].thumb = pcxThumb(c, 96, ph) || list[0].thumb; pcxSaveHist(list); } } catch {}
  const url = URL.createObjectURL(blob), name = `pill-count-${d.count}-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}.png`;
  const file = (() => { try { return new File([blob], name, { type: "image/png" }); } catch { return null; } })();
  let canShare = false; try { canShare = !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch {}
  const close = () => { closeModal(); setTimeout(() => URL.revokeObjectURL(url), 30000); };
  openModal(el("div", null, el("h2", { text: "Count record" }), el("p", { text: canShare ? "Share it, or press and hold the image to save." : "Download it, or press and hold the image to save." }),
    el("img", { class: "recimg", src: url, alt: `Count record: ${d.count} pills` }),
    el("div", { class: "row" },
      canShare ? el("button", { class: "btn pri", text: "Share", onclick: async () => { try { await navigator.share({ files: [file], title: "Pill count record", text: `${d.count} pills counted` }); } catch (e) { if (e && e.name !== "AbortError") toast("Sharing failed. Use Download instead."); } } }) : null,
      el("a", { class: "btn" + (canShare ? "" : " pri"), href: url, download: name, text: "Download" }),
      el("a", { class: "btn", href: url, target: "_blank", rel: "noopener", text: "Open" })),
    el("div", { class: "row" }, el("button", { class: "btn", text: "Done", onclick: close }))));
}

/* ---- hands-free auto capture ---- */
function pcxAutoTick(now) {
  const ring = $("#autoRing"), d = PCX.lastD;
  const ok = PCX.o.auto && !PCI.on && !S.frozen && !S.busy && S.source && S.source.kind !== "photo" && d && d.locked && d.conf >= 0.85 && d.count > 0
    && $("#modalWrap").hidden && !S.roiEdit && !S.calibrating && !document.hidden;
  if (!ok) { if (PCX.autoAt) { PCX.autoAt = 0; ring.style.display = "none"; } return; }
  if (!PCX.autoAt) { PCX.autoAt = now; ring.style.display = "block"; }
  const p = Math.min(1, (now - PCX.autoAt) / 2000);
  $("#autoRingC").style.strokeDashoffset = String(251.3 * (1 - p));
  if (p >= 1) { PCX.autoAt = 0; ring.style.display = "none"; pcxBeep(); pcxBuzz(30); capture(); }
}

/* ---- settings sheet ---- */
function pcxOpenSettings() {
  let armH = false;
  const sw = (key, label, sub) => {
    const b = el("button", { class: "opt", role: "switch", "aria-checked": String(!!PCX.o[key]), onclick: () => {
      PCX.o[key] = !PCX.o[key]; b.setAttribute("aria-checked", String(PCX.o[key])); pcxSaveOpts();
      if (key === "wake") pcxWake(true);
      if (key === "groups") PCX.groupsOn = PCX.o.groups;
      if (key === "voice") { if (PCX.o.voice) { PCX.touched = true; pcxSay("Voice on"); } else { try { speechSynthesis.cancel(); } catch {} } }
      if (key === "sound" && PCX.o.sound) pcxBeep();
      pcxApplyOpts(); if (!PCX.o.auto) PCX.autoAt = 0; pcxRefresh();
    } }, el("span", { class: "lbl" }, label, el("small", { text: sub, style: "color:var(--muted);font-weight:500" })), el("span", { class: "sw2" }));
    return b;
  };
  const unitBtns = ["mm", "in"].map((u) => el("button", { class: "btn" + (PCX.o.units === u ? " pri" : ""), text: u === "mm" ? "Millimetres" : "Inches", onclick: () => { PCX.o.units = u; pcxSaveOpts(); unitBtns.forEach((b, i) => b.classList.toggle("pri", ["mm", "in"][i] === u)); S.idKey = ""; scheduleId(true); } }));
  const hb = el("button", { class: "btn", text: "Clear history", onclick: () => { if (!armH) { armH = true; hb.textContent = "Tap again to clear"; return; } pcxSaveHist([]); hb.textContent = "History cleared"; armH = false; } });
  openModal(el("div", null, el("h2", { text: "Settings" }),
    sw("voice", "Voice readout", "Speaks the count and odd-pill alerts"),
    sw("sound", "Click sound", "Soft tick when the count locks"),
    sw("auto", "Hands-free capture", "Captures after the count stays locked for 2 s"),
    sw("burst", "Burst capture (more accurate)", "Takes 3 quick photos and keeps the count they agree on"),
    sw("groups", "Groups of 5 by default", "Shade the captured photo in fives"),
    sw("wake", "Keep screen awake", "Stops the phone sleeping while counting"),
    sw("contrast", "High-contrast overlay", "Bolder, brighter markers"),
    el("h3", { class: "sec", text: "Size units" }), el("div", { class: "row", style: "margin-top:0" }, ...unitBtns),
    el("h3", { class: "sec", text: "Data" }),
    el("div", { class: "row", style: "margin-top:0" },
      el("button", { class: "btn", text: "Reset calibration", onclick: () => { S.mmPerNorm = null; S.calLabel = ""; persist(); scheduleId(true); toast("Calibration reset"); } }), hb),
    el("div", { class: "row" }, el("button", { class: "btn pri", text: "Done", onclick: closeModal }))));
}
function pcxInit() {
  if (pcxInit.done) return; pcxInit.done = true;
  pcxApplyOpts(); pcxRenderChips();
  $("#btnSet").addEventListener("click", pcxOpenSettings);
  $("#chipQty").addEventListener("click", pcxOpenQty);
  $("#chipAdd").addEventListener("click", pcxAddTally);
  $("#chipTally").addEventListener("click", pcxOpenTally);
  $("#chipUndo").addEventListener("click", pcxUndoTally);
  $("#chipG5").addEventListener("click", () => { PCX.groupsOn = !PCX.groupsOn; pcxApplyOpts(); toast(PCX.groupsOn ? (S.frozen ? "Groups of 5 on" : "Groups of 5 will show on the captured photo") : "Groups of 5 off", 1800); });
  $("#btnSave").addEventListener("click", pcxRecord);
  $("#btnRecount").addEventListener("click", pcxRecount);
  if (PCX.o.wake) pcxWake(false);
}

/* ============================== Identify mode (pci*) ============================== */
// Close-up pill identifier: reticle crop -> stable traits -> frozen magnified imprint helper -> ranked matches.
const PCI = {
  on: false, want: store.get("pc.appmode", "count") === "identify", phase: "scan", target: 0, epoch: 0, loopOn: false, hold: 0,
  frames: [], best: null, pick: null, cands: [], live: null, sig: "", pickSig: "", pt: -1, tickCount: null,
  fr: null, imp: ["", ""], act: 0, fi: 0, timer: 0, inps: [], steady: 0,
  cal: store.get("pc.pci.cal", null), cropCv: document.createElement("canvas"), natCv: document.createElement("canvas"),
};
const PCI_N = 6;
const pciSaveCal = () => { if (!(PCI.cal && PCI.cal.demo)) store.set("pc.pci.cal", PCI.cal); };
const pciKind = (g) => (g.colors || []).join("/") + "|" + (g.shape || "");

/* ---- demo scene: one pink oval ~10 mm with a faint debossed "894 5", plus a penny off to the side ---- */
function pciDemoDraw() {
  const g = demoCv.getContext("2d"), W = 720, H = 960, j = () => Math.random() - 0.5;
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#34404f"); bg.addColorStop(1, "#222831"); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.save(); g.translate(585 + j(), 705 + j());
  const cg = g.createRadialGradient(-25, -30, 8, 0, 0, 84); cg.addColorStop(0, "#d9915a"); cg.addColorStop(1, "#8f4f26");
  g.shadowColor = "rgba(0,0,0,.45)"; g.shadowBlur = 14; g.shadowOffsetY = 6; g.fillStyle = cg; g.beginPath(); g.arc(0, 0, 84, 0, 7); g.fill(); g.restore();
  const A = 44, B = 30;
  g.save(); g.translate(360 + j() * 1.5, 480 + j() * 1.5); g.rotate(-0.38 + j() * 0.02);
  const pg = g.createRadialGradient(-A * 0.3, -B * 0.4, 3, 0, 0, A * 1.1); pg.addColorStop(0, "#f4a8d0"); pg.addColorStop(1, "#d86aa8");
  g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 12; g.shadowOffsetY = 5; g.fillStyle = pg; g.beginPath(); g.ellipse(0, 0, A, B, 0, 0, 7); g.fill(); g.shadowColor = "transparent";
  g.textAlign = "center"; g.textBaseline = "middle"; g.font = "700 15px Arial, sans-serif";
  if (PCI.target === 0) {
    g.fillStyle = "rgba(255,255,255,.55)"; g.fillText("894 5", 0.9, 1.1); g.fillStyle = "rgba(150,60,95,.5)"; g.fillText("894 5", -0.4, -0.4);
  } else { g.strokeStyle = "rgba(150,60,95,.25)"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-A * 0.6, 0); g.lineTo(A * 0.6, 0); g.stroke(); }
  g.restore();
}

/* ---- capture geometry ---- */
function pciGeom() { const [w, h] = S.source.dims(), m = Math.min(w, h), cs = Math.round(m * 0.45); return { w, h, cs, cx: (w - cs) / 2, cy: (h - cs) / 2 }; }
function pciGrab() {
  const G = pciGeom(), src = S.source.el, c = PCI.cropCv, n = PCI.natCv, ns = Math.min(G.cs, 1000);
  const dp = S.source.getDepth ? S.source.getDepth() : null;
  nbaDM.set(c, dp ? nbaCropDepth(dp, G.cx, G.cy, G.cs, 720 / G.cs, G.w, G.h) : null);
  if (c.width !== 720) c.width = c.height = 720;
  if (n.width !== ns) n.width = n.height = ns;
  c.getContext("2d", { willReadFrequently: true }).drawImage(src, G.cx, G.cy, G.cs, G.cs, 0, 0, 720, 720);
  n.getContext("2d").drawImage(src, G.cx, G.cy, G.cs, G.cs, 0, 0, ns, ns);
  return { ...G, ns };
}
function pciSharp(c, p) {
  const r = Math.max(p.a, p.b) * 1.05, x0 = pcClamp(Math.round(p.x - r), 0, c.width - 8), y0 = pcClamp(Math.round(p.y - r), 0, c.height - 8);
  const w = Math.min(Math.round(r * 2), c.width - x0), h = Math.min(Math.round(r * 2), c.height - y0);
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h).data, gr = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gr[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; s += Math.abs(4 * gr[i] - gr[i - 1] - gr[i + 1] - gr[i - w] - gr[i + w]); n++; }
  return n ? s / n : 0;
}
function pciRegion(f, res, p, g, sharp, key) {
  const k = f.ns / (res.width || 720), side = Math.round(Math.min(f.ns, Math.max(96, Math.max(p.a, p.b) * 2 * 1.35 * k)));
  const x0 = pcClamp(Math.round(p.x * k - side / 2), 0, f.ns - side), y0 = pcClamp(Math.round(p.y * k - side / 2), 0, f.ns - side);
  const cv2 = document.createElement("canvas"); cv2.width = cv2.height = side;
  cv2.getContext("2d").drawImage(PCI.natCv, x0, y0, side, side, 0, 0, side, side);
  return { cv: cv2, sharp, key, cs: f.cs, p: { x: p.x * k - x0, y: p.y * k - y0, a: p.a * k, b: p.b * k, th: p.theta || 0 } };
}

/* ---- analysis loop (one alive; ~3 fps; one in flight) ---- */
async function pciLoop() {
  if (PCI.loopOn) return; PCI.loopOn = true;
  while (PCI.on && PCI.phase === "scan" && S.source) {
    const t0 = performance.now();
    if (!document.hidden && $("#modalWrap").hidden && !PCI.hold) {
      try {
        if (S.source.tick) S.source.tick();
        const ep = PCI.epoch, f = pciGrab(), mm = PCI.cal ? PCI.cal.mmPerSrc * f.cs / 720 : 0, o = { mode: "free", fast: false };
        if (mm) o.mmPerPx = mm;
        const dpo = nbaDepthFor(PCI.cropCv, 720); if (dpo) { o.depth = dpo; delete o.mmPerPx; }
        const raw = await engine.run(imageDataOf(PCI.cropCv), o);
        if (ep === PCI.epoch && PCI.on && PCI.phase === "scan") pciOnResult(normalise(raw), f);
      } catch (e) { await sleep(150); }
    }
    await sleep(Math.max(document.hidden ? 300 : 20, 330 - (performance.now() - t0)));
  }
  PCI.loopOn = false;
}
function pciOnResult(res, f) {
  const W = res.width || 720, mid = W / 2, minR = W * 0.03;
  const near = (p) => Math.hypot(p.x - mid, p.y - mid);
  const ok = res.pills.filter((p) => res.groups[p.group] && Math.max(p.a, p.b) >= minR && near(p) < W * 0.5);
  const cands = [];
  res.groups.forEach((g, gi) => { const q = ok.filter((p) => p.group === gi).sort((a, b) => near(a) - near(b))[0]; if (q) cands.push({ g, p: q }); });
  PCI.cands = cands;
  let pickC = PCI.pick ? cands.filter((c) => pciKind(c.g) === PCI.pick) : cands;
  const c0 = pickC.slice().sort((a, b) => near(a.p) - near(b.p))[0];
  PCI.res = res;
  if (!c0) PCI.frames.push(null);
  else {
    const { g, p } = c0, key = (g.colors || []).join("/");
    PCI.frames.push({ key, shape: g.shape || "", two: !!g.twoTone, len: g.lengthMm || 0, g, p, kind: pciKind(g) });
    const sh = pciSharp(PCI.cropCv, p);
    if (!PCI.best || PCI.best.key !== key || sh > PCI.best.sharp) PCI.best = pciRegion(f, res, p, g, sh, key);
  }
  if (PCI.frames.length > PCI_N) PCI.frames.shift();
  PCI.live = pciVote();
  const recent = PCI.frames, steady = !!PCI.live && recent.length >= PCI_N && PCI.live.n >= PCI_N - 1;
  PCI.steady = PCI.live ? PCI.live.n / PCI_N : 0;
  pciRenderLive(steady);
  if (steady) pciGot();
}
function pciVote() {
  const v = PCI.frames.filter(Boolean); if (!v.length) return null;
  const sig = (f) => f.key + "|" + f.shape + "|" + f.two, cnt = new Map();
  v.forEach((f) => cnt.set(sig(f), (cnt.get(sig(f)) || 0) + 1));
  let bk = null, bn = 0; cnt.forEach((n, k) => { if (n > bn) { bn = n; bk = k; } });
  const m = v.filter((f) => sig(f) === bk), last = m[m.length - 1], lens = m.map((f) => f.len).filter((x) => x > 0).sort((a, b) => a - b);
  return { n: bn, g: last.g, colors: (last.g.colors || []).slice(), shape: last.shape || null, two: last.two, len: lens.length ? lens[lens.length >> 1] : 0 };
}
const pciGroupOf = (v) => ({ ...v.g, count: 1, role: "primary", colors: v.colors.slice(), shape: v.shape, twoTone: v.two, lengthMm: v.len || null });

/* ---- live readout ---- */
function pciIconFor(v) { return v ? iconForGroup(pciGroupOf(v)) : { shape: "round", cssColors: ["rgba(128,128,128,.35)"] }; }
function pciRenderLive(steady) {
  const v = PCI.live, panel = $("#idPanel"), st = $("#idState");
  const sig = v ? [v.colors.join("/"), v.shape, v.two, v.len ? Math.round(v.len * 2) : 0, PCI.cal ? 1 : 0, PCX.o.units].join("|") : "none";
  if (sig !== PCI.sig) {
    PCI.sig = sig; const tr = $("#idTraits"); tr.textContent = "";
    drawPillIcon($("#idIcon"), pciIconFor(v), 64);
    if (!v) tr.append(el("span", { class: "chip", text: "No pill yet" }));
    else {
      v.colors.forEach((c, i) => tr.append(el("span", { class: "chip" }, el("i", { class: "sw", style: `background:${v.g.halvesRgb && v.g.halvesRgb[i] ? rgbCss(v.g.halvesRgb[i]) : colorHex(c)}` }), c)));
      if (!v.colors.length) tr.append(el("span", { class: "chip", text: "colour?" }));
      if (v.two && v.colors.length < 2) tr.append(el("span", { class: "chip", text: "two-tone" }));
      if (v.shape) tr.append(el("span", { class: "chip", text: v.shape }));
      tr.append(v.len ? el("span", { class: "chip num", text: pcxLen(v.len) }) : el("button", { class: "chip link", text: "Add a coin for size", onclick: pciOpenCal }));
    }
  }
  const txt = !v ? "Looking for a pill…" : steady ? "Got it ✓" : "Steady…";
  if ($("#idStateTxt").textContent !== txt) $("#idStateTxt").textContent = txt;
  st.className = "idstate " + (steady ? "ok" : v ? "hold" : "");
  const fill = $("#idSteady"); fill.style.width = Math.round((steady ? 1 : PCI.steady * 0.9) * 100) + "%"; fill.style.setProperty("--c", steady ? "var(--accent)" : "var(--amber)");
  panel.classList.toggle("got", steady);
  pciRenderPicks();
}
function pciRenderPicks() {
  const box = $("#idPicks"), cs = PCI.cands.length > 1 ? PCI.cands : [];
  const cur = PCI.live ? PCI.live.g : null, sig = cs.map((c) => pciKind(c.g)).join(";") + "#" + (PCI.pick || "") + "#" + (cur ? pciKind(cur) : "");
  if (sig === PCI.pickSig) return; PCI.pickSig = sig; box.textContent = "";
  cs.forEach((c, i) => {
    const kind = pciKind(c.g), on = PCI.pick ? PCI.pick === kind : !!cur && pciKind(cur) === kind;
    const ic = el("canvas"); drawPillIcon(ic, iconForGroup(c.g), 28);
    box.append(el("button", { class: "pchip glass", "aria-pressed": String(on), "aria-label": `Pill ${i + 1}: ${pcDescribe(c.g)}`, onclick: () => { PCI.pick = PCI.pick === kind ? null : kind; PCI.frames = []; PCI.best = null; PCI.live = null; PCI.pickSig = ""; PCI.sig = ""; pciRenderLive(false); } }, ic, `${i + 1} · ${pcDescribe(c.g)}`));
  });
}
function pciSetPrompt() {
  $("#idPrompt").textContent = PCI.target === 1 ? "Flip the pill over and place it in the circle" : "Place one pill in the circle";
  $("#idCancelFlip").hidden = PCI.target !== 1;
}
function pciGot() {
  if (PCI.phase !== "scan") return;
  PCI.phase = "got"; PCI.epoch++; a11y("Got it"); pcxBeep(); pcxBuzz(20);
  setTimeout(() => { if (PCI.on && PCI.phase === "got") pciFreeze(); }, RM ? 60 : 520);
}

/* ---- reticle overlay (drawn on the shared #overlay canvas from frame()) ---- */
function pciDraw(now) {
  if (!PCI.on || PCI.phase === "frozen" || !S.source) return;
  const cw = cv.clientWidth, ch = cv.clientHeight, G = pciGeom(), s = Math.max(cw / G.w, ch / G.h), R = G.cs * s / 2, cx = cw / 2, cy = ch / 2, t = now / 1000;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fill("evenodd");
  const has = !!PCI.live, got = PCI.phase === "got";
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = got ? "#19d3c5" : has ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.7)";
  ctx.setLineDash(has ? [] : [10, 8]); ctx.lineDashOffset = RM ? 0 : -t * 18; ctx.stroke(); ctx.setLineDash([]);
  if (has) { ctx.beginPath(); ctx.arc(cx, cy, R + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (got ? 1 : PCI.steady), false); ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.strokeStyle = got ? "#19d3c5" : "#ffb42e"; ctx.stroke(); }
  const sc = (2 * R) / 720;
  PCI.cands.forEach((c, i) => {
    const sel = PCI.live && pciKind(c.g) === pciKind(PCI.live.g), x = cx - R + c.p.x * sc, y = cy - R + c.p.y * sc;
    ctx.save(); ctx.translate(x, y); ctx.rotate(c.p.theta || 0); ctx.beginPath(); ctx.ellipse(0, 0, c.p.a * sc + 2, c.p.b * sc + 2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = sel ? "#19d3c5" : "rgba(255,255,255,.8)"; ctx.lineWidth = sel ? 3 : 2; if (!sel) ctx.setLineDash([6, 5]); ctx.stroke(); ctx.restore();
    if (PCI.cands.length > 1) chip(ctx, String(i + 1), x, y - Math.max(c.p.a, c.p.b) * sc - 12, sel ? "#0f8f86" : "rgba(30,30,30,.85)");
  });
  ctx.restore();
  const top = Math.round(cy + R + 18); if (top !== PCI.pt) { PCI.pt = top; $("#idPrompt").style.top = top + "px"; }
}

/* ---- freeze + imprint helper ---- */
function pciFreeze() {
  const best = PCI.best, v = PCI.live;
  if (!best || !v) { PCI.phase = "scan"; PCI.frames = []; pciLoop(); return toast("No pill found. Try again."); }
  const side = { src: best.cv, p: best.p, enh: true, inv: false, view: { z: 1, x: 0, y: 0, rot: 0 }, N: 0, gray: null, orig: null, vis: null, visKey: "" };
  if (PCI.target === 1 && PCI.fr) { PCI.fr.sides[1] = side; PCI.act = 1; PCI.fi = 1; }
  else {
    const dm = PCI.res && PCI.res.depth && PCI.res.depth.used && PCI.res.depth.mmPerPx, mmpp = dm || (PCI.cal ? PCI.cal.mmPerSrc * best.cs / 720 : 0);
    PCI.fr = { group: pciGroupOf(v), mmPerPx: mmpp, sides: [side], rows: [], q: "", hist: { t: Date.now(), thumb: pcxThumb(best.cv, 96), chosen: null } };
    PCI.imp = ["", ""]; PCI.act = 0; PCI.fi = 0;
  }
  PCI.phase = "frozen"; PCI.target = 0; PCI.epoch++; PCI.frames = []; PCI.best = null; PCI.live = null; PCI.sig = ""; PCI.pickSig = "";
  pciShowRes(); pciRunId();
}
function pciBox(src, n, r) {
  const tmp = new Float32Array(n * n), out = new Float32Array(n * n), w = 2 * r + 1, cl = (x) => (x < 0 ? 0 : x > n - 1 ? n - 1 : x);
  for (let y = 0; y < n; y++) { const o = y * n; let s = 0; for (let x = -r; x <= r; x++) s += src[o + cl(x)]; for (let x = 0; x < n; x++) { tmp[o + x] = s / w; s += src[o + cl(x + r + 1)] - src[o + cl(x - r)]; } }
  for (let x = 0; x < n; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[cl(y) * n + x]; for (let y = 0; y < n; y++) { out[y * n + x] = s / w; s += tmp[cl(y + r + 1) * n + x] - tmp[cl(y - r) * n + x]; } }
  return out;
}
function pciPrep(s) {
  if (s.gray) return;
  const N = Math.max(64, Math.min(1200, s.src.width * 4)), up = document.createElement("canvas"); up.width = up.height = N;
  const u = up.getContext("2d", { willReadFrequently: true }); u.imageSmoothingEnabled = true; u.imageSmoothingQuality = "high"; u.drawImage(s.src, 0, 0, N, N);
  const d = u.getImageData(0, 0, N, N).data, n2 = N * N, g = new Float32Array(n2);
  for (let i = 0; i < n2; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  const big = pciBox(g, N, Math.max(6, (N / 14) | 0)), sm = pciBox(g, N, 3), v = new Float32Array(n2);
  for (let i = 0; i < n2; i++) v[i] = (g[i] - big[i]) * 0.6 + (g[i] - sm[i]) * 1.8;
  const samp = []; for (let i = 0; i < n2; i += 37) samp.push(Math.abs(v[i]));
  samp.sort((a, b) => a - b); const sc = Math.max(4, samp[Math.floor(samp.length * 0.985)] || 4), out = new Uint8ClampedArray(n2);
  for (let i = 0; i < n2; i++) out[i] = 128 + v[i] * (120 / sc);
  s.N = N; s.orig = d; s.gray = out;
}
function pciVis(s) {
  const key = (s.enh ? "e" : "o") + (s.inv ? "i" : ""); if (s.visKey === key && s.vis) return s.vis;
  const N = s.N, c = s.vis || (s.vis = Object.assign(document.createElement("canvas"), { width: N, height: N })), x = c.getContext("2d"), id = x.createImageData(N, N), d = id.data;
  for (let i = 0; i < N * N; i++) {
    let r, g, b; if (s.enh) r = g = b = s.gray[i]; else { r = s.orig[i * 4]; g = s.orig[i * 4 + 1]; b = s.orig[i * 4 + 2]; }
    if (s.inv) { r = 255 - r; g = 255 - g; b = 255 - b; }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  x.putImageData(id, 0, 0); s.visKey = key; return c;
}
function pciDrawZoom() {
  const z = $("#idZoom"); if (!z || !PCI.fr) return; const s = PCI.fr.sides[PCI.act]; if (!s) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3), cw = z.clientWidth, ch = z.clientHeight;
  if (z.width !== Math.round(cw * dpr) || z.height !== Math.round(ch * dpr)) { z.width = Math.round(cw * dpr); z.height = Math.round(ch * dpr); }
  const g = z.getContext("2d"); g.setTransform(z.width / cw, 0, 0, z.height / ch, 0, 0); g.fillStyle = "#000"; g.fillRect(0, 0, cw, ch);
  if (!s.gray) { g.fillStyle = "rgba(255,255,255,.7)"; g.font = "600 15px -apple-system, system-ui, sans-serif"; g.textAlign = "center"; g.fillText("Enhancing…", cw / 2, ch / 2); return; }
  const v = s.view, base = Math.min(cw, ch) / s.N;
  g.save(); g.translate(cw / 2 + v.x, ch / 2 + v.y); g.rotate(v.rot * Math.PI / 180); g.scale(base * v.z, base * v.z); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(pciVis(s), -s.N / 2, -s.N / 2); g.restore();
}
function pciBindZoom(z) {
  const P = new Map(); let last = 0; const view = () => PCI.fr.sides[PCI.act].view;
  z.addEventListener("pointerdown", (e) => { z.setPointerCapture(e.pointerId); P.set(e.pointerId, [e.clientX, e.clientY]); last = 0; });
  z.addEventListener("pointermove", (e) => {
    if (!P.has(e.pointerId)) return; const v = view(), o = P.get(e.pointerId); P.set(e.pointerId, [e.clientX, e.clientY]);
    if (P.size === 1) { v.x += e.clientX - o[0]; v.y += e.clientY - o[1]; }
    else if (P.size === 2) { const [a, b] = [...P.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (last) v.z = pcClamp(v.z * d / last, 1, 10); last = d; v.x += (e.clientX - o[0]) / 2; v.y += (e.clientY - o[1]) / 2; }
    pciDrawZoom();
  });
  const up = (e) => { P.delete(e.pointerId); last = 0; };
  z.addEventListener("pointerup", up); z.addEventListener("pointercancel", up);
  z.addEventListener("wheel", (e) => { e.preventDefault(); const v = view(); v.z = pcClamp(v.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 10); pciDrawZoom(); }, { passive: false });
  z.addEventListener("dblclick", () => { Object.assign(view(), { z: 1, x: 0, y: 0 }); pciDrawZoom(); });
}
function pciInsert(txt, back) {
  const inp = PCI.inps[PCI.fi] || PCI.inps[0]; if (!inp) return;
  const s = inp.selectionStart == null ? inp.value.length : inp.selectionStart, e = inp.selectionEnd == null ? s : inp.selectionEnd;
  let a = inp.value.slice(0, s), b = inp.value.slice(e); if (back) { if (s === e) a = a.slice(0, -1); } else a += txt;
  inp.value = a + b; inp.focus(); try { inp.setSelectionRange(a.length, a.length); } catch {}
  inp.dispatchEvent(new Event("input"));
}
function pciShowRes() {
  const fr = PCI.fr, R = $("#idRes"); $("#idPanel").hidden = true; $("#idPrompt").hidden = true; R.hidden = false; R.textContent = "";
  const two = fr.sides.length > 1;
  const zoom = el("canvas", { id: "idZoom", role: "img", "aria-label": "Magnified, contrast-enhanced pill for reading the imprint" });
  const tabs = two ? el("div", { class: "idsides" }, ["Side A", "Side B"].map((t, i) => el("button", { class: "pchip", text: t, "aria-pressed": String(PCI.act === i), onclick: (e) => { PCI.act = i; PCI.fi = i; tabs.querySelectorAll("button").forEach((b, k) => b.setAttribute("aria-pressed", String(k === i))); pciSyncTools(); pciPrepDraw(); } }))) : null;
  const bEnh = el("button", { class: "pchip", text: "Enhance", "aria-pressed": "true", onclick: () => { const s = fr.sides[PCI.act]; s.enh = !s.enh; pciSyncTools(); pciDrawZoom(); } });
  const bInv = el("button", { class: "pchip", text: "Invert", "aria-pressed": "false", onclick: () => { const s = fr.sides[PCI.act]; s.inv = !s.inv; pciSyncTools(); pciDrawZoom(); } });
  const bRot = el("button", { class: "pchip", text: "Rotate ↻", onclick: () => { const v = fr.sides[PCI.act].view; v.rot = (v.rot + 90) % 360; pciDrawZoom(); } });
  const bRst = el("button", { class: "pchip", text: "Reset", onclick: () => { Object.assign(fr.sides[PCI.act].view, { z: 1, x: 0, y: 0, rot: 0 }); pciDrawZoom(); } });
  PCI.sync = () => { const s = fr.sides[PCI.act]; bEnh.setAttribute("aria-pressed", String(s.enh)); bInv.setAttribute("aria-pressed", String(s.inv)); };
  const mkInp = (i) => {
    const inp = el("input", { class: "idinp", type: "text", placeholder: i ? "Imprint on the other side" : "e.g. 894 5", autocapitalize: "characters", autocomplete: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "search", "aria-label": `Imprint, side ${i ? "B" : "A"}` });
    inp.value = PCI.imp[i];
    inp.addEventListener("focus", () => { PCI.fi = i; if (fr.sides[i] && PCI.act !== i) { PCI.act = i; if (tabs) tabs.querySelectorAll("button").forEach((b, k) => b.setAttribute("aria-pressed", String(k === i))); pciSyncTools(); pciPrepDraw(); } });
    inp.addEventListener("input", () => { PCI.imp[i] = inp.value; clearTimeout(PCI.timer); PCI.timer = setTimeout(pciRunId, 350); });
    return inp;
  };
  PCI.inps = [mkInp(0)]; if (two) PCI.inps.push(mkInp(1));
  const key = (label, txt, back) => el("button", { text: label, "aria-label": back ? "Backspace" : label === "␣" ? "Space" : label, onclick: () => pciInsert(txt, back) });
  const keys = el("div", { class: "keys", role: "group", "aria-label": "Quick characters" },
    key("␣", " "), key("/", "/"), key("·", "·"), key("-", "-"), key("+", "+"), key("&", "&"), ["0", "O", "1", "I", "5", "S", "8", "B"].map((c) => key(c, c)), key("⌫", "", true),
    el("button", { text: "Clear", style: "font-family:var(--font);font-size:.9rem", onclick: () => { const i = PCI.fi; PCI.inps[i].value = ""; PCI.inps[i].dispatchEvent(new Event("input")); PCI.inps[i].focus(); } }));
  const g = fr.group, ic = el("canvas"); drawPillIcon(ic, iconForGroup(g), 44);
  const traits = el("div", { class: "traits", style: "align-items:center;margin-top:10px" }, ic,
    (g.colors && g.colors.length ? g.colors : ["colour?"]).map((c, i) => el("span", { class: "chip" }, el("i", { class: "sw", style: `background:${g.halvesRgb && g.halvesRgb[i] ? rgbCss(g.halvesRgb[i]) : colorHex(c)}` }), c)),
    g.twoTone && (g.colors || []).length < 2 ? el("span", { class: "chip", text: "two-tone" }) : null, g.shape ? el("span", { class: "chip", text: g.shape }) : null,
    g.lengthMm ? el("span", { class: "chip num", text: pcxLen(g.lengthMm) }) : el("span", { class: "chip", text: "size unknown" }));
  const wrap = el("div", { class: "wrap" }, tabs, zoom,
    el("div", { class: "idtools" }, bEnh, bInv, bRot, bRst),
    el("p", { class: "idcap", text: "Pinch or drag to zoom. Look for letters and numbers pressed into the pill, then type them below." }),
    traits,
    el("label", { class: "idlbl", text: two ? "Imprint, side A" : "Imprint (letters and numbers on the pill)" }, PCI.inps[0]),
    two ? el("label", { class: "idlbl", text: "Imprint, side B" }, PCI.inps[1]) : null, keys,
    el("button", { class: "lockbtn ghost", style: "margin-top:12px;width:100%", text: two ? "Re-scan the other side" : "Flip pill — scan the other side", onclick: pciFlip }),
    el("div", { id: "idList", style: "margin-top:6px" }),
    el("div", { class: "row" }, el("button", { class: "btn pri", text: "Scan another pill", onclick: pciRescan })));
  R.append(wrap); R.scrollTop = 0; pciBindZoom(zoom); pciSyncTools(); pciRenderList();
  pciPrepDraw();
}
const pciSyncTools = () => { if (PCI.sync) PCI.sync(); };
function pciPrepDraw() {
  pciDrawZoom();
  const s = PCI.fr && PCI.fr.sides[PCI.act]; if (!s || s.gray) return;
  setTimeout(() => { if (!PCI.fr || !s || PCI.fr.sides[PCI.act] !== s) return; try { pciPrep(s); } catch (e) { toast("Could not enhance the image"); } pciDrawZoom(); }, 40);
}
function pciFlip() {
  if (!PCI.fr || !S.source) return;
  PCI.target = 1; PCI.phase = "scan"; PCI.epoch++; PCI.frames = []; PCI.best = null; PCI.live = null; PCI.sig = ""; PCI.pickSig = "";
  $("#idRes").hidden = true; $("#idPanel").hidden = false; $("#idPrompt").hidden = false; pciSetPrompt(); pciRenderLive(false); pciLoop();
}
function pciCancelFlip() { PCI.target = 0; PCI.phase = "frozen"; PCI.epoch++; $("#idPanel").hidden = true; $("#idPrompt").hidden = true; $("#idRes").hidden = false; }
function pciRescan() {
  PCI.fr = null; PCI.imp = ["", ""]; PCI.target = 0; PCI.phase = "scan"; PCI.epoch++; PCI.frames = []; PCI.best = null; PCI.live = null; PCI.pick = null; PCI.sig = ""; PCI.pickSig = "";
  $("#idRes").hidden = true; $("#idRes").textContent = ""; $("#idPanel").hidden = false; $("#idPrompt").hidden = false; pciSetPrompt(); pciRenderLive(false); pciLoop();
}

/* ---- results ---- */
const pciQuery = () => PCI.imp.map((s) => s.trim()).filter(Boolean).join(" ");
function pciRunId() {
  const fr = PCI.fr; if (!fr) return; fr.q = pciQuery();
  try { fr.rows = identify(fr.group, { mmPerPx: fr.mmPerPx || undefined, imprint: fr.q || undefined, limit: 12 }) || []; } catch { fr.rows = []; }
  pciRenderList();
  const h = fr.hist; if (h && !h.chosen) { const t = fr.rows[0]; Object.assign(h, t ? { name: t.name, strength: t.strength, imprint: t.imprint, score: t.score } : { name: "", score: 0 }); h.q = fr.q; pciSaveEntry(h); }
}
function pciCard(r, i, best) {
  const fr = PCI.fr, ck = r.name + "|" + r.strength + "|" + r.imprint, chosen = fr.hist && fr.hist.chosen === ck, sc = Math.round((r.score || 0) * 100);
  const ic = el("canvas"); drawPillIcon(ic, iconForRow(r), 44);
  return el("div", { class: "card" + (best ? " best" : "") + (chosen ? " chosen" : ""), style: `animation-delay:${Math.min(i, 8) * 40}ms` }, ic, el("div", { class: "ci" },
    best ? el("div", { class: "tag", style: "background:var(--accent);color:var(--accent-ink);margin:0 0 4px" }, "Best match") : null,
    el("div", { class: "nm" }, r.name, r.strength ? el("small", { text: "  " + r.strength }) : null),
    r.generic && r.generic.toLowerCase() !== String(r.name).toLowerCase() ? el("div", { class: "meta", text: r.generic }) : null,
    r.imprint ? el("div", { class: "im", text: "Imprint: " + r.imprint }) : null,
    el("div", { class: "meta", text: [(r.colors || []).join("/"), r.shape, r.sizeMm ? pcxLen(+r.sizeMm) : ""].filter(Boolean).join(" · ") }),
    r.labeler ? el("div", { class: "meta", text: r.labeler }) : null,
    el("div", { class: "score" }, el("span", { text: sc + "%", class: "num", style: "min-width:34px" }), el("div", { class: "bar" }, el("i", { style: `width:${sc}%;--c:${sc >= 85 ? "var(--accent)" : sc > 40 ? "var(--accent-2)" : "var(--amber)"}` }))),
    el("div", null, (r.reasons || []).slice(0, 5).map((t) => el("span", { class: "tag", text: t }))),
    el("div", { class: "btns" },
      el("button", { class: "lockbtn" + (best ? "" : " ghost"), text: "Count these", onclick: () => pciCountThese(r) }),
      el("button", { class: "lockbtn ghost", text: chosen ? "✓ Saved" : "Save match", onclick: () => { fr.hist.chosen = ck; Object.assign(fr.hist, { name: r.name, strength: r.strength, imprint: r.imprint, score: r.score, q: fr.q }); pciSaveEntry(fr.hist); toast("Saved to identify history"); pciRenderList(); } }),
      el("a", { class: "lockbtn ghost", href: "https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=" + encodeURIComponent(r.name), target: "_blank", rel: "noopener", text: "DailyMed ↗" })),
    pciSimilar(r)));
}
function pciSimilar(r) {
  const body = el("div"), d = el("details", { class: "sim" }, el("summary", { text: "Similar-looking" }), body);
  d.addEventListener("toggle", () => {
    if (!d.open || d._f) return; d._f = 1; let rows = [];
    try { rows = identify({ count: 1, role: "primary", colors: (r.colors || []).slice(), twoTone: (r.colors || []).length > 1, shape: r.shape || null, lengthMm: +r.sizeMm || null }, { limit: 12 }) || []; } catch {}
    rows = rows.filter((x) => !(x.name === r.name && x.strength === r.strength && x.imprint === r.imprint)).slice(0, 6);
    if (!rows.length) body.append(el("div", { class: "meta", text: "No look-alikes in the on-device database." }));
    rows.forEach((x) => body.append(el("div", { class: "simrow" }, el("b", { text: x.name + (x.strength ? "  " + x.strength : "") }), el("span", { text: [x.imprint ? "Imprint " + x.imprint : "", (x.colors || []).join("/"), x.shape, x.sizeMm ? pcxLen(+x.sizeMm) : ""].filter(Boolean).join(" · ") }))));
  });
  return d;
}
function pciRenderList() {
  const L = $("#idList"), fr = PCI.fr; if (!L || !fr) return; L.textContent = "";
  const rows = fr.rows, strong = rows.length && rows[0].score >= 0.85;
  L.append(el("div", { class: "notice" }, el("span", { text: "⚠️" }), el("div", null, "Appearance and imprint suggest possibilities only. Confirm with the label, the pharmacist, or DailyMed before use.")));
  if (!fr.q) L.append(el("p", { class: "idcap", style: "margin:0 0 8px", text: "No imprint entered yet. The letters and numbers on the pill narrow this down far more than colour and shape." }));
  if (!rows.length) { L.append(el("div", { class: "empty", text: "No close matches in the on-device database. Check the imprint spelling, or try the other side." })); return; }
  if (strong) {
    L.append(el("h3", { class: "sec", text: "Best match" }), pciCard(rows[0], 0, true));
    if (rows.length > 1) L.append(el("h3", { class: "sec", text: "Other possibilities" }));
    rows.slice(1).forEach((r, i) => L.append(pciCard(r, i + 1, false)));
  } else {
    L.append(el("h3", { class: "sec", text: "Possible matches — check the imprint" }));
    rows.forEach((r, i) => L.append(pciCard(r, i, false)));
  }
}
function pciCountThese(row) {
  const g = PCI.fr ? PCI.fr.group : null;
  S.lock = { row, sig: { colors: g ? g.colors || [] : row.colors || [], shape: g ? g.shape : row.shape, rgb: g ? g.rgb : null } };
  S.idKey = ""; pciSetAppMode("count"); toast(`Counting only ${row.name}`);
}

/* ---- identify history (last 20) ---- */
function pciSaveEntry(h) {
  if (!h || !h.name) return;
  let list = store.get("pc.idhist", []); if (!Array.isArray(list)) list = [];
  const i = list.findIndex((e) => e.t === h.t), e = { t: h.t, thumb: h.thumb, name: h.name, strength: h.strength || "", imprint: h.imprint || "", score: h.score || 0, q: h.q || "", chosen: !!h.chosen };
  if (i >= 0) list[i] = e; else list.unshift(e);
  list = list.slice(0, 20);
  const put = (l) => { try { localStorage.setItem("pc.idhist", JSON.stringify(l)); return true; } catch { return false; } };
  if (put(list)) return;
  const l = list.map((x) => ({ ...x })); for (let k = l.length - 1; k >= 0; k--) if (l[k].thumb) { delete l[k].thumb; if (put(l)) return; }
  while (l.length > 1) { l.pop(); if (put(l)) return; }
}
function pciOpenHistory() {
  const list = store.get("pc.idhist", []); let armed = false;
  const body = list.length ? list.map((h) => el("div", { class: "hist" }, h.thumb ? el("img", { class: "thumb", src: h.thumb, alt: "" }) : null,
    el("div", { style: "min-width:0;flex:1" }, el("div", { text: h.name + (h.strength ? " " + h.strength : ""), style: "font-weight:600" }), el("span", { text: [h.imprint ? "Imprint " + h.imprint : "", h.q ? `typed “${h.q.toUpperCase()}”` : "no imprint typed", Math.round((h.score || 0) * 100) + "%", h.chosen ? "saved" : ""].filter(Boolean).join(" · ") })),
    el("div", { class: "r" }, el("span", { text: new Date(h.t).toLocaleDateString([], { month: "short", day: "numeric" }) }), el("br"), el("span", { text: new Date(h.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })))) : [el("div", { class: "empty", text: "No identifications yet." })];
  const clr = el("button", { class: "btn", text: "Clear", onclick: () => { if (!armed) { armed = true; clr.textContent = "Tap again to clear"; return; } store.set("pc.idhist", []); pciOpenHistory(); } });
  openModal(el("div", null, el("h2", { text: "Recent identifications" }), el("p", { text: "Saved on this phone only. Possibilities, not confirmations." }), ...body,
    el("div", { class: "row" }, list.length ? clr : null, el("button", { class: "btn pri", text: "Done", onclick: closeModal }))));
}

/* ---- size from a coin (reuses REFS) ---- */
function pciOpenCal() {
  let sel = "quarter"; const opts = [];
  const mk = (r) => { const b = el("button", { class: "opt" + (r.key === sel ? " sel" : ""), onclick: () => { sel = r.key; opts.forEach((o) => o.el.classList.toggle("sel", o.key === sel)); } }, r.label, el("small", { text: r.mm + " mm" })); opts.push({ key: r.key, el: b }); return b; };
  openModal(el("div", null, el("h2", { text: "Add a coin for size" }),
    el("p", { text: PCI.cal ? `Sized with ${PCI.cal.label}. Keep the phone at this same height.` : "Lay a coin flat next to the pill, inside the dimmed area, then tap Measure. Keep the phone at that height afterwards." }),
    ...REFS.map(mk),
    el("div", { class: "row" },
      PCI.cal ? el("button", { class: "btn", text: "Clear", onclick: () => { PCI.cal = null; store.set("pc.pci.cal", null); PCI.sig = ""; PCI.frames = []; PCI.best = null; PCI.live = null; PCI.epoch++; closeModal(); toast("Size cleared"); } }) : null,
      el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
      el("button", { class: "btn pri", text: "Measure", onclick: () => pciMeasure(REFS.find((r) => r.key === sel)) }))));
}
async function pciMeasure(ref) {
  closeModal(); PCI.hold++; toast("Measuring…", 1400);
  try {
    if (S.source.tick) S.source.tick();
    const G = pciGeom(), cs = Math.round(Math.min(G.w, G.h) * 0.9), W = 960, c = document.createElement("canvas"); c.width = c.height = W;
    c.getContext("2d", { willReadFrequently: true }).drawImage(S.source.el, (G.w - cs) / 2, (G.h - cs) / 2, cs, cs, 0, 0, W, W);
    const res = normalise(await engine.run(imageDataOf(c), { mode: "free", fast: false })), ps = res.pills.filter((p) => Math.max(p.a, p.b) > W * 0.02);
    if (ps.length < 1) { toast("Could not see the coin. Lay it flat inside the dimmed area and try again", 3600); return; }
    let ci = 0; ps.forEach((p, i) => { if (p.a * p.b > ps[ci].a * ps[ci].b) ci = i; });
    const sz = 300, pv = document.createElement("canvas"); pv.width = pv.height = sz; pv.style.cssText = "width:100%;max-width:300px;display:block;margin:0 auto 10px;border-radius:14px;touch-action:manipulation";
    const draw = () => {
      const g = pv.getContext("2d"), k = sz / W; g.drawImage(c, 0, 0, sz, sz);
      ps.forEach((p, i) => { g.save(); g.translate(p.x * k, p.y * k); g.rotate(p.theta || 0); g.beginPath(); g.ellipse(0, 0, p.a * k + 2, p.b * k + 2, 0, 0, Math.PI * 2); g.lineWidth = i === ci ? 4 : 2; g.strokeStyle = i === ci ? "#19d3c5" : "rgba(255,255,255,.8)"; g.stroke(); g.restore(); });
    };
    draw();
    pv.addEventListener("click", (e) => {
      const r = pv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * W; let bi = ci, bd = 1e9;
      ps.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y) / Math.max(p.a, p.b); if (d < bd) { bd = d; bi = i; } }); ci = bi; draw();
    });
    openModal(el("div", null, el("h2", { text: ps.length > 1 ? `Which one is the ${ref.label}?` : `Is this the ${ref.label}?` }), el("p", { text: "The highlighted object will be used as the size reference." + (ps.length > 1 ? " Tap another to change it." : " If it is not the coin, cancel and try again with the coin flat and clear of other objects.") }), pv,
      el("div", { class: "row" }, el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn pri", text: "Use this", onclick: () => {
          const p = ps[ci], srcPerPx = cs / W, mm = ref.mm / (2 * Math.max(p.a, p.b) * srcPerPx);
          PCI.cal = { mmPerSrc: mm, label: ref.label }; pciSaveCal(); PCI.sig = ""; PCI.frames = []; PCI.best = null; PCI.live = null; PCI.epoch++;
          closeModal(); toast(`Sized with the ${ref.label}. Remove it and keep the phone at this height.`, 3600);
        } }))));
  } catch (e) { toast("Could not measure. Try again."); }
  finally { PCI.hold = Math.max(0, PCI.hold - 1); }
}

/* ---- mode switch ---- */
function pciSyncSeg() {
  const seg = $("#appSeg"), th = seg.querySelector(".thumb");
  seg.querySelectorAll("button[data-app]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.app === "identify") === PCI.want)));
  const act = seg.querySelector(`[data-app="${PCI.want ? "identify" : "count"}"]`);
  th.style.width = act.offsetWidth + "px"; th.style.transform = `translateX(${act.offsetLeft - 3}px)`;
}
function pciSetAppMode(m) {
  const id = m === "identify"; PCI.want = id; store.set("pc.appmode", id ? "identify" : "count"); pciSyncSeg();
  if (id === PCI.on) return;
  if (id) pciEnter(); else pciLeave();
}
function pciEnter() {
  if (!S.source) return;
  if (S.source.kind === "photo") { toast("Identify needs the live camera"); PCI.want = false; store.set("pc.appmode", "count"); pciSyncSeg(); return; }
  PCI.on = true;
  if (S.frozen) retake();
  closeModal(); toggleSheet(false); $("#guide").hidden = true; S.calibrating = null; setHint(""); PCX.autoAt = 0; $("#autoRing").style.display = "none";
  app.classList.add("idm"); S.res = null; markers = []; S.idKey = ""; resetStability();
  if (S.demo) { if (!PCI.cal && !PCI.demoInit) PCI.cal = { mmPerSrc: 10 / 88, label: "demo scale", demo: true }; PCI.demoInit = true; if (!PCI.tickCount) { PCI.tickCount = S.source.tick; S.source.tick = pciDemoDraw; } }
  Object.assign(PCI, { phase: "scan", target: 0, fr: null, frames: [], best: null, live: null, pick: null, cands: [], sig: "", pickSig: "", hold: 0 }); PCI.epoch++; PCI.imp = ["", ""];
  $("#idv").hidden = false; $("#idRes").hidden = true; $("#idPanel").hidden = false; $("#idPrompt").hidden = false; pciSetPrompt(); pciRenderLive(false);
  pciLoop();
}
function pciLeave() {
  PCI.on = false; PCI.epoch++; PCI.hold = 0; clearTimeout(PCI.timer);
  app.classList.remove("idm"); $("#idv").hidden = true; closeModal();
  if (S.demo && PCI.tickCount !== null && S.source) { S.source.tick = PCI.tickCount; PCI.tickCount = null; }
  if (S.source) { const [w, h] = S.source.dims(); S.imgW = w; S.imgH = h; }
  setMode(S.mode, true); S.res = null; S.idKey = ""; resetStability(); renderHUD(computeDisplay()); renderPeek(null); S.fit = "cover";
  if (S.source && !S.frozen) liveLoop();
}
function pciInit() {
  if (pciInit.done) return; pciInit.done = true;
  $("#appSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-app]"); if (b) pciSetAppMode(b.dataset.app); });
  $("#idCapNow").addEventListener("click", () => { if (PCI.phase !== "scan") return; if (!PCI.best || !PCI.live) return toast("Place a pill in the circle first"); PCI.phase = "got"; PCI.epoch++; pciFreeze(); });
  $("#idCancelFlip").addEventListener("click", pciCancelFlip);
  window.addEventListener("resize", () => { pciSyncSeg(); pciDrawZoom(); });
  pciSyncSeg(); requestAnimationFrame(pciSyncSeg);
}

/* ============================== boot ============================== */
async function boot() {
  pcxInit(); pciInit(); setMode(S.mode, true); renderHUD(computeDisplay()); renderPeek(null);
  requestAnimationFrame(() => setMode(S.mode, true));
  if (S.demo) {
    $("#fallback").hidden = true; startDemo(); liveLoop();
    $("#sub").textContent = "Demo mode"; if (PCI.want && !PCI.on) pciEnter(); return;
  }
  try {
    $("#fallback").hidden = true; if (nbAvailable()) await nbaStartNative(); else await startCamera(); liveLoop(); if (PCI.want && !PCI.on) pciEnter();
  } catch (e) {
    const name = (e && e.name) || "Error";
    const denied = name === "NotAllowedError" || name === "SecurityError";
    showFallback(denied ? "Camera access is off" : "Camera unavailable",
      denied ? "Allow camera access in Settings > Safari > Camera, then try again — or take a photo instead." : "This page can't open the live camera here (it needs https). Take a photo of your tray and we will count it the same way.",
      `${name}: ${(e && e.message) || ""}`.slice(0, 120));
  }
}
window.addEventListener("resize", () => setMode(S.mode, true));
requestAnimationFrame(frame);
loadId().catch(() => {});
boot();
// test hook (harmless in production)
window.__pc = { PCI, pciSetAppMode, pciRenderPicks, pciOpenHistory, PCX, pcxRecord, pcxRecount, pcxAddTally, pcxOpenSettings, pcxOpenQty, S, engine, capture, retake, onTap, toggleSheet, normalise };
