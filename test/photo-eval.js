// Real-photo accuracy evaluation page. Pick photos -> analyze (4 runs each) -> table + summary.
import { analyze } from "../src/pillcv.js";

const $ = (id) => document.getElementById(id);
const RUNS = [
  { key: "full/tray", fast: false, mode: "tray" },
  { key: "full/free", fast: false, mode: "free" },
  { key: "fast/tray", fast: true, mode: "tray" },
  { key: "fast/free", fast: true, mode: "free" },
];
const FULL_PX = 1600, FAST_PX = 640;
const results = [];
let busy = false;
const tick = () => new Promise((r) => setTimeout(r, 20));

export function parseName(name) {
  const base = name.replace(/\.[^.]+$/, "");
  const parts = base.split(/[_\s]+/);
  const m = /^(\d+)(?:\D.*)?$/.exec(parts[0]);
  const truth = m && /^\d+$/.test(parts[0]) ? parseInt(parts[0], 10) : null;
  let broken = null, odd = null;
  for (const t of parts.slice(1)) {
    let k;
    if ((k = /^(\d+)broken$/i.exec(t))) broken = +k[1];
    else if ((k = /^(\d+)odd$/i.exec(t))) odd = +k[1];
    else if (/^broken$/i.test(t)) broken = 1;
    else if (/^odd$/i.test(t)) odd = 1;
  }
  return { truth, broken, odd };
}

async function decode(file) {
  // returns an ImageBitmap or HTMLImageElement with orientation applied
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* fall back */ }
    try { return await createImageBitmap(file); } catch (e) { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img; // browsers apply EXIF orientation to <img> by default
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

function scaled(src, sw, sh, longSide) {
  const s = Math.min(1, longSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  // step-down for huge images so the downscale is not aliased
  let cur = src, cw = sw, ch = sh;
  while (cw / 2 > w * 1.5 && ch / 2 > h * 1.5) {
    const t = document.createElement("canvas");
    t.width = Math.round(cw / 2); t.height = Math.round(ch / 2);
    t.getContext("2d").drawImage(cur, 0, 0, t.width, t.height);
    cur = t; cw = t.width; ch = t.height;
  }
  g.drawImage(cur, 0, 0, w, h);
  return { canvas: c, ctx: g, w, h };
}

function drawMarkers(canvas, res) {
  const g = canvas.getContext("2d");
  g.lineWidth = Math.max(2, canvas.width / 400);
  for (const p of res.pills) {
    const odd = p.group > 0, low = p.conf === "low";
    g.strokeStyle = odd ? "#ff2a2a" : low ? "#ffb000" : "#19d24a";
    g.beginPath();
    g.ellipse(p.x, p.y, Math.max(2, p.a), Math.max(2, p.b), p.theta, 0, 2 * Math.PI);
    g.stroke();
    if (odd && low) { g.setLineDash([6, 4]); g.strokeStyle = "#ffb000"; g.stroke(); g.setLineDash([]); }
  }
  g.strokeStyle = "#ff00ff";
  for (const f of res.fragments || []) {
    const r = Math.max(4, f.b || 6);
    g.beginPath();
    g.moveTo(f.x - r, f.y - r); g.lineTo(f.x + r, f.y + r);
    g.moveTo(f.x + r, f.y - r); g.lineTo(f.x - r, f.y + r);
    g.stroke();
  }
}

function slim(res, ms) {
  return {
    total: res.total, range: res.range, confidence: res.confidence, ms,
    oddFound: res.pills.filter((p) => p.group > 0).length,
    brokenFound: (res.fragments || []).length,
    lowConf: res.pills.filter((p) => p.conf === "low").length,
    warnings: res.warnings, groups: res.groups,
    pills: res.pills.map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), a: +p.a.toFixed(1), b: +p.b.toFixed(1), theta: +p.theta.toFixed(3), group: p.group, conf: p.conf })),
    fragments: (res.fragments || []).map((f) => ({ x: +f.x.toFixed(1), y: +f.y.toFixed(1) })),
  };
}

async function processFile(file) {
  const truthInfo = parseName(file.name);
  const rec = { file: file.name, bytes: file.size, ...truthInfo, runs: {}, error: null };
  let bmp;
  try { bmp = await decode(file); } catch (e) {
    rec.error = "Could not decode this image (" + (e && e.message || e) + "). HEIC may need converting to JPG.";
    return { rec, thumb: null };
  }
  const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
  rec.srcSize = [sw, sh];
  const full = scaled(bmp, sw, sh, FULL_PX);
  const fastC = scaled(bmp, sw, sh, FAST_PX);
  if (bmp.close) bmp.close();
  rec.fullSize = [full.w, full.h]; rec.fastSize = [fastC.w, fastC.h];
  const fullData = full.ctx.getImageData(0, 0, full.w, full.h);
  const fastData = fastC.ctx.getImageData(0, 0, fastC.w, fastC.h);
  const overlay = document.createElement("canvas");
  overlay.width = full.w; overlay.height = full.h;
  overlay.getContext("2d").drawImage(full.canvas, 0, 0);
  let markRes = null;
  for (const run of RUNS) {
    await tick();
    const d = run.fast ? fastData : fullData;
    const t0 = performance.now();
    try {
      const res = analyze(d.data, d.width, d.height, { mode: run.mode, fast: run.fast });
      const ms = Math.round(performance.now() - t0);
      rec.runs[run.key] = slim(res, ms);
      if (run.key === "full/tray") markRes = res;
      else if (!markRes && run.key === "full/free") markRes = res;
    } catch (e) {
      rec.runs[run.key] = { error: String(e && e.message || e) };
    }
  }
  if (markRes) drawMarkers(overlay, markRes);
  return { rec, thumb: overlay };
}

function verdict(rec, r) {
  if (!r || r.error || rec.truth == null) return null;
  const err = r.total - rec.truth;
  return { err, exact: err === 0, within1: Math.abs(err) <= 1, inRange: rec.truth >= r.range[0] && rec.truth <= r.range[1] };
}

const mark = (ok) => ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function addRow(rec, thumb) {
  const tr = document.createElement("tr");
  const td0 = document.createElement("td");
  if (thumb) { thumb.className = "thumb"; td0.appendChild(thumb); }
  const cap = document.createElement("div");
  cap.className = "mut"; cap.textContent = rec.file + (rec.srcSize ? ` (${rec.srcSize[0]}x${rec.srcSize[1]})` : "");
  td0.appendChild(cap);
  if (rec.error) { const e = document.createElement("div"); e.className = "bad"; e.textContent = rec.error; td0.appendChild(e); }
  const td1 = document.createElement("td");
  td1.innerHTML = rec.truth == null ? '<span class="mut">unknown</span>' : `<b>${rec.truth}</b>`;
  const td2 = document.createElement("td");
  const td3 = document.createElement("td");
  const td4 = document.createElement("td");
  const warns = new Set();
  const bo = [];
  for (const run of RUNS) {
    const r = rec.runs[run.key];
    const div = document.createElement("div");
    div.className = "run";
    if (!r) { div.innerHTML = `<b>${run.key}</b> <span class="mut">-</span>`; }
    else if (r.error) { div.innerHTML = `<b>${run.key}</b> <span class="bad">error: ${esc(r.error)}</span>`; }
    else {
      const v = verdict(rec, r);
      let h = `<b>${run.key}</b> <b>${r.total}</b> [${r.range[0]}-${r.range[1]}] ${(r.confidence * 100).toFixed(0)}% <span class="mut">${r.ms}ms</span>`;
      if (v) h += ` exact ${mark(v.exact)} range ${mark(v.inRange)}${v.err ? ` <span class="mut">(${v.err > 0 ? "+" : ""}${v.err})</span>` : ""}`;
      div.innerHTML = h;
      for (const w of r.warnings || []) warns.add(w);
      bo.push(`${run.key}: broken ${r.brokenFound}${rec.broken != null ? "/" + rec.broken : ""}, odd ${r.oddFound}${rec.odd != null ? "/" + rec.odd : ""}`);
    }
    td2.appendChild(div);
  }
  td3.innerHTML = bo.map(esc).join("<br>") || '<span class="mut">-</span>';
  td4.innerHTML = [...warns].map((w) => `<div class="warn">${esc(w)}</div>`).join("") || '<span class="mut">none</span>';
  tr.append(td0, td1, td2, td3, td4);
  $("rows").appendChild(tr);
}

function renderSummary() {
  const scored = results.filter((r) => r.truth != null);
  let h = `<p class="mut">${results.length} photos, ${scored.length} with a known count.</p><table><thead><tr><th>Run</th><th>Exact</th><th>Within ±1</th><th>In range</th><th>Mean abs error</th><th>Avg confidence: right</th><th>Avg confidence: wrong</th><th>Avg ms</th></tr></thead><tbody>`;
  for (const run of RUNS) {
    let n = 0, ex = 0, w1 = 0, ir = 0, ae = 0, cr = 0, nr = 0, cw = 0, nw = 0, ms = 0, nms = 0;
    for (const rec of results) {
      const r = rec.runs[run.key];
      if (r && !r.error) { ms += r.ms; nms++; }
      const v = verdict(rec, r);
      if (!v) continue;
      n++; ae += Math.abs(v.err);
      if (v.exact) { ex++; cr += r.confidence; nr++; } else { cw += r.confidence; nw++; }
      if (v.within1) w1++;
      if (v.inRange) ir++;
    }
    const pct = (x) => n ? (100 * x / n).toFixed(0) + "%" : "-";
    h += `<tr><td><b>${run.key}</b></td><td>${pct(ex)} <span class="mut">(${ex}/${n})</span></td><td>${pct(w1)}</td><td>${pct(ir)}</td><td>${n ? (ae / n).toFixed(2) : "-"}</td><td>${nr ? (100 * cr / nr).toFixed(0) + "%" : "-"}</td><td>${nw ? (100 * cw / nw).toFixed(0) + "%" : "-"}</td><td>${nms ? Math.round(ms / nms) : "-"}</td></tr>`;
  }
  h += "</tbody></table>";
  $("sumtab").innerHTML = h;
  $("summary").hidden = false;
}

async function handleFiles(fileList) {
  if (busy) return;
  const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name));
  if (!files.length) { $("status").textContent = "No image files found."; return; }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  busy = true; $("pick").disabled = true;
  $("results").hidden = false;
  $("prog").hidden = false; $("prog").max = files.length; $("prog").value = 0;
  for (let i = 0; i < files.length; i++) {
    $("status").textContent = `Analysing ${i + 1} of ${files.length}: ${files[i].name}`;
    await tick();
    try {
      const { rec, thumb } = await processFile(files[i]);
      results.push(rec);
      addRow(rec, thumb);
    } catch (e) {
      const rec = { file: files[i].name, runs: {}, error: String(e && e.message || e), ...parseName(files[i].name) };
      results.push(rec); addRow(rec, null);
    }
    $("prog").value = i + 1;
    renderSummary();
    $("dl").disabled = false;
  }
  $("status").textContent = `Done: ${results.length} photos.`;
  $("prog").hidden = true; $("pick").disabled = false; busy = false;
}

function download() {
  const out = {
    generated: new Date().toISOString(), userAgent: navigator.userAgent,
    engine: { fullPx: FULL_PX, fastPx: FAST_PX, runs: RUNS.map((r) => r.key) },
    results,
  };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "photo-eval-results.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
$("dl").addEventListener("click", download);
const drop = $("drop");
for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
document.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
window.__photoEval = { handleFiles, results };
