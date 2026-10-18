// Pill identification: ranks FDA label appearances against a detected group, fuzzy imprint search and name/brand search.
// Data: src/pill-db.js (compact DailyMed appearance table). Parameters below were tuned with test/id-eval.mjs.
import { PILL_DB } from "./pill-db.js";

// ---------- imprint normalisation ----------
const CONFUSE = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", G: "6", Z: "2" };
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const canon = (s) => norm(s).replace(/[OQDILSBGZ]/g, (c) => CONFUSE[c]);

// true if edit distance <= 1 (substitution, insertion, deletion, or one adjacent swap)
function lev1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// bounded edit distance (insert/delete/substitute/adjacent swap); returns max+1 when larger than max
function pidEd(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const la = a.length, lb = b.length;
  let p2 = null, p1 = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    p2 = p1; p1 = cur;
  }
  return Math.min(p1[lb], max + 1);
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  if (arr.length > 4) return [arr];
  const out = [];
  arr.forEach((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).forEach((p) => out.push([x, ...p])));
  return out;
}

// ---------- tunable parameters (defaults = tuned values; test/id-eval.mjs --tune searches these) ----------
const PID = {
  near: 3, floorC: 0.02, twoMiss: 0.12, twoSpur: 0.06, noColor: 0.7,
  shapeCross: 1.8, shapeUnknown: 0.8, shapePow: 1, aspSigma: 0.15, aspMin: 0.3,
  szA: 0.2, szB: 0.05, szFloor: 0.08, szNoDb: 0.6,
  prior: 0.25, variety: 0.93, cap: 0.6, imA: 0.5, imMiss: 0.18, lam: 0.5,
  fzBase: 0.4, fzSlope: 0.08, mContain: 0.65, mSide: 0.7, imG: 1, imB: 0.5,
};
export function pidSetParams(p) { Object.assign(PID, p || {}); pidRebuild(); return PID; }
export function pidGetParams() { return { ...PID }; }

// ---------- colour likelihood: rel[true][seen], diagonal = 1 ----------
const PID_COLORS = ["white", "yellow", "orange", "pink", "red", "brown", "green", "turquoise", "blue", "purple", "gray", "black"];
const PID_CI = {}; PID_COLORS.forEach((c, i) => { PID_CI[c] = i; });
// how likely the camera reports <seen> for a product whose label says <row>, relative to reporting it correctly
const PID_NEAR = {
  white: { gray: 0.2, yellow: 0.13, pink: 0.06, turquoise: 0.03, blue: 0.03 },
  yellow: { white: 0.13, orange: 0.22, brown: 0.05, green: 0.05 },
  orange: { yellow: 0.2, red: 0.14, brown: 0.16, pink: 0.16 },
  pink: { red: 0.22, orange: 0.16, white: 0.1, purple: 0.08, brown: 0.04 },
  red: { pink: 0.16, orange: 0.16, brown: 0.16, purple: 0.04 },
  brown: { orange: 0.22, red: 0.1, black: 0.05, gray: 0.05, yellow: 0.04 },
  green: { turquoise: 0.18, yellow: 0.05, blue: 0.05, gray: 0.04 },
  turquoise: { blue: 0.22, green: 0.2, white: 0.04, gray: 0.04 },
  blue: { turquoise: 0.22, purple: 0.13, gray: 0.05, green: 0.04 },
  purple: { blue: 0.13, pink: 0.1, gray: 0.04 },
  gray: { white: 0.2, black: 0.12, blue: 0.04, brown: 0.04 },
  black: { gray: 0.16, brown: 0.07, blue: 0.03, purple: 0.03 },
};
let PID_CM = null;
function pidBuildColors() {
  PID_CM = new Float64Array(13 * 13);
  for (let r = 0; r < 13; r++) for (let s = 0; s < 13; s++) {
    let v = r === s ? 1 : PID.floorC;
    if (r < 12 && s < 12 && r !== s) {
      const nv = (PID_NEAR[PID_COLORS[r]] || {})[PID_COLORS[s]];
      if (nv != null) v = Math.max(PID.floorC, Math.min(1, nv * PID.near));
    }
    if (r === 12 || s === 12) v = r === s ? 1 : 0.05; // colour the app does not know
    PID_CM[r * 13 + s] = v;
  }
}

function pidColorSim(sg, e) {
  const M = PID_CM, n = sg.length, r1 = e.c1, r2 = e.c2;
  if (!n) return PID.noColor;
  if (n === 1) {
    if (r2 < 0) return M[r1 * 13 + sg[0]];
    return PID.twoMiss * Math.max(M[r1 * 13 + sg[0]], M[r2 * 13 + sg[0]]) + 0.002; // one seen vs two-colour product
  }
  if (r2 < 0) return PID.twoSpur * Math.max(M[r1 * 13 + sg[0]], M[r1 * 13 + sg[1]]) + 0.002;
  const a = M[r1 * 13 + sg[0]] * M[r2 * 13 + sg[1]], b = M[r1 * 13 + sg[1]] * M[r2 * 13 + sg[0]];
  return Math.sqrt(Math.max(a, b));
}

// ---------- shape likelihood ----------
const PID_DET = ["round", "oval", "capsule", "four-sided", "triangle"];
const EXP_ASPECT = { round: 1, square: 1, diamond: 1.05, "double circle": 1, triangle: 1.1, oval: 1.5, capsule: 2.2, rectangle: 1.9, tear: 1.4, bullet: 1.8, "semi-circle": 1.6, egg: 1.4, trapezoid: 1.2 };
function aspectExpect(shape) {
  if (EXP_ASPECT[shape] != null) return EXP_ASPECT[shape];
  if (/hexagon|pentagon|octagon|heptagon|clover|gear|freeform|star/.test(shape)) return 1.05;
  return null;
}

function detShape(g) {
  if (g.shape) return g.shape;
  if (g.aspect) return g.aspect > 1.85 ? "capsule" : g.aspect > 1.13 ? "oval" : "round";
  return null;
}

// P(engine says <det> | label says <row>) relative to the best case; cross-class confusions scaled by PID.shapeCross
function shapeSim(det, row) {
  const t = {
    capsule: { capsule: 1, bullet: 0.6, oval: 0.5, rectangle: 0.45, tear: 0.3, egg: 0.3 },
    oval: { oval: 1, capsule: 0.5, tear: 0.5, egg: 0.6, rectangle: 0.3, bullet: 0.4, "semi-circle": 0.2, round: 0.15, trapezoid: 0.15 },
    round: { round: 1, "double circle": 0.5, oval: 0.15, square: 0.12, egg: 0.15 },
    "four-sided": { square: 1, diamond: 1, rectangle: 0.9, "four-sided": 1, trapezoid: 0.8, round: 0.2, oval: 0.1 },
    triangle: { triangle: 1, "semi-circle": 0.3, trapezoid: 0.2 },
  }[det] || {};
  let v;
  if (t[row] != null) v = t[row];
  else if (det === "round" && /hexagon|pentagon|octagon|heptagon|clover|gear|freeform|star/.test(row)) v = 0.45;
  else if (det === "four-sided" && /pentagon|hexagon|freeform/.test(row)) v = 0.25;
  else if (det === "oval" && /freeform|clover|heptagon/.test(row)) v = 0.2;
  else v = 0.07;
  return v >= 1 ? 1 : Math.pow(v, 1 / Math.max(0.2, PID.shapeCross));
}

// ---------- database prep ----------
const ENTRIES = [];
const PID_SHAPEVEC = new Map();
let PID_ID = new Map(); // identity (ingredients + strength + release type) -> {n, pop, entries}
let PID_IDS = []; // same objects, indexable (entry.ix)
let PID_GEN = new Map(); // generic key -> {brands:Map, names:Set}
let PID_INFO = { rows: 0, drugs: 0, identities: 0, labelers: 0, built: "" };
const PID_SALT = new Set("hydrochloride hcl sodium potassium calcium magnesium besylate maleate tartrate succinate bitartrate sulfate phosphate mesylate fumarate citrate hydrobromide acetate medoxomil anhydrous monohydrate dihydrate hemihydrate trihydrate bromide chloride nitrate carbonate oxide hydrate disodium dipropionate propionate valerate lactate gluconate pamoate mononitrate dinitrate saccharate aspartate dihydrochloride cypionate bisulfate hemifumarate tosylate dimesylate decanoate hyclate monosodium sesquihydrate propanediol propylene glycol solvate cilexetil axetil mofetil etexilate disoproxil alafenamide benzoate stearate xinafoate pivoxil proxetil tromethamine besilate malate oxalate napsylate pidolate orotate edisylate meglumine dimeglumine hydroxide".split(" "));
const pidWords = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
function pidGKey(name) {
  const w = pidWords(name), k = w.filter((x) => !PID_SALT.has(x));
  return (k.length ? k : w).join(" ");
}
const pidAmt = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
function pidIdKey(generic, strength, form) {
  const ings = String(generic).split(" / "), amts = String(strength).split(" / ");
  const pairs = ings.length === amts.length ? ings.map((g, i) => pidGKey(g) + "=" + pidAmt(amts[i])) : ings.map(pidGKey).concat(["~" + pidAmt(strength)]);
  return pairs.sort().join("+") + (/release/.test(form) ? "#xr" : "");
}
const pidGenKey = (generic) => String(generic).split(" / ").map(pidGKey).sort().join("+");

function pidShapeVec(shape) {
  let v = PID_SHAPEVEC.get(shape);
  if (!v) { v = new Float64Array(6); PID_SHAPEVEC.set(shape, v); }
  for (let i = 0; i < 5; i++) v[i] = shapeSim(PID_DET[i], shape);
  v[5] = PID.shapeUnknown;
  return v;
}

function pidRebuild() {
  pidBuildColors();
  PID_SHAPEVEC.forEach((_, k) => pidShapeVec(k));
}

(function build() {
  const D = PILL_DB, S = D.S, L = D.L, C = D.C, H = D.H;
  const popByLabeler = new Map();
  const labelerSet = new Set();
  for (const r of D.R) {
    const colors = C[r[4]].map((c) => String(c).toLowerCase());
    const sides = String(r[3] || "").split(";").map((s) => s.trim()).filter(Boolean);
    const shape = String(H[r[5]] || "").toLowerCase();
    const cs = sides.map(canon).filter(Boolean);
    const generic = S[r[1]], strength = S[r[2]], form = S[r[11]] || "";
    const ci1 = PID_CI[colors[0]], ci2 = colors.length > 1 ? PID_CI[colors[1]] : -1;
    if (!PID_SHAPEVEC.has(shape)) PID_SHAPEVEC.set(shape, null);
    const e = {
      i: ENTRIES.length, name: S[r[0]], generic, strength, colors, shape, sizeMm: r[6] ? r[6] / 10 : null,
      labelers: r[7].map((i) => L[i]), brand: S[r[8]] || "", ndc: r[9] || "", rxcui: r[10] || "", form, n: r[12] || 1,
      imprintText: sides.join(" · "), perms: permutations(cs).map((p) => p.join("")),
      rawPerms: permutations(sides.map(norm).filter(Boolean)).map((p) => p.join("")), sides: cs,
      rawSet: null, permSet: null, blob: "",
      c1: ci1 == null ? 12 : ci1, c2: colors.length < 2 ? -1 : ci2 == null ? 12 : ci2,
      exAsp: aspectExpect(shape), sv: null,
      idKey: pidIdKey(generic, strength, form), genKey: pidGenKey(generic),
    };
    e.rawSet = new Set(e.rawPerms); e.permSet = new Set(e.perms); e.blob = e.perms.join("|");
    ENTRIES.push(e);
    for (const l of e.labelers) labelerSet.add(l);
    let id = PID_ID.get(e.idKey);
    if (!id) { id = { n: 0, entries: [], ix: PID_IDS.length }; PID_ID.set(e.idKey, id); PID_IDS.push(id); }
    id.n += e.n; id.entries.push(e.i); e.ix = id.ix;
    let gk = PID_GEN.get(e.genKey);
    if (!gk) { gk = { brands: new Map(), n: 0 }; PID_GEN.set(e.genKey, gk); }
    gk.n++;
    if (e.brand) gk.brands.set(e.brand, (gk.brands.get(e.brand) || 0) + 1);
  }
  let maxN = 1;
  for (const id of PID_ID.values()) maxN = Math.max(maxN, id.n);
  for (const id of PID_ID.values()) id.pop = Math.log(1 + id.n) / Math.log(1 + maxN);
  for (const e of ENTRIES) { const id = PID_IDS[e.ix]; e.pop = id.pop; e.w = e.n / id.n; }
  PID_INFO = { rows: ENTRIES.length, drugs: PID_GEN.size, identities: PID_ID.size, labelers: labelerSet.size, built: D.built || "" };
  pidRebuild();
  for (const e of ENTRIES) e.sv = PID_SHAPEVEC.get(e.shape);
})();

export function pidDbInfo() { return { ...PID_INFO }; }
export function pidEntries() { return ENTRIES; }

// ---------- imprint matching: m in 0..1 ----------
const PID_HOW = [[1, "imprint matches"], [0.92, "imprint matches (OCR-tolerant)"], [0.8, "imprint matches one side"], [0.7, "imprint partly matches"], [0.6, "imprint contained"], [0.3, "imprint similar"]];
const pidHow = (m) => { for (const [t, s] of PID_HOW) if (m >= t - 1e-9) return s; return "imprint similar"; };

function pidImQuery(text) {
  const q = norm(text);
  return {
    q, qc: canon(text),
    tokens: String(text).toUpperCase().split(/[\s;,/·]+/).map(canon).filter(Boolean),
  };
}

function pidAnyLev1(list, qc, minLen) {
  for (let i = 0; i < list.length; i++) { const p = list[i]; if (p.length >= minLen && Math.abs(p.length - qc.length) <= 1 && lev1(p, qc)) return true; }
  return false;
}

function imprintM(Q, e) {
  const { q, qc, tokens } = Q;
  if (!q || !e.sides.length) return 0;
  if (e.rawPerms[0] === q) return 1;
  if (e.rawSet.has(q)) return 0.995;
  if (e.permSet.has(qc)) return 0.92;
  const multi = tokens.length > 1;
  if (multi) { let all = true; for (const t of tokens) if (!e.sides.includes(t)) { all = false; break; } if (all) return 0.92; }
  if (e.sides.includes(qc)) return PID.mSide;
  if (multi) { let all = true; for (const t of tokens) if (!e.blob.includes(t)) { all = false; break; } if (all) return 0.7; }
  const L = qc.length;
  if (L === 2) return pidAnyLev1(e.perms, qc, 2) || pidAnyLev1(e.sides, qc, 2) ? 0.3 : 0;
  if (L >= 3) {
    if (e.blob.includes(qc)) return PID.mContain;
    const fz = PID.fzBase + PID.fzSlope * Math.min(L - 3, 3);
    if (pidAnyLev1(e.perms, qc, 1) || pidAnyLev1(e.sides, qc, 3)) return fz;
    if (multi) { let all = true; for (const t of tokens) { if (!(e.sides.includes(t) || (t.length >= 3 && pidAnyLev1(e.sides, t, 1)))) { all = false; break; } } if (all) return fz - 0.05; }
  }
  return 0;
}

// ---------- appearance ----------
function groupLengthMm(g, mmPerPx) {
  if (g.lengthMm) return g.lengthMm;
  const mp = mmPerPx || g.mmPerPx;
  if (g.lengthPx && mp) return g.lengthPx * mp;
  return null;
}

function pidGroupInfo(g, mmPerPx) {
  const seen = (g.colors && g.colors.length ? g.colors : []).map((c) => PID_CI[String(c).toLowerCase()]).filter((x) => x != null).slice(0, 2);
  const ds = detShape(g);
  const di = ds ? PID_DET.indexOf(ds) : 5;
  return { sg: seen, ds, di: di < 0 ? 5 : di, asp: g.aspect && ds ? g.aspect : null, len: groupLengthMm(g, mmPerPx) };
}

function pidShapeScore(gi, e) {
  let sh = e.sv[gi.di];
  if (gi.asp && e.exAsp && gi.di < 5) {
    const d = Math.log(gi.asp / e.exAsp);
    sh *= PID.aspMin + (1 - PID.aspMin) * Math.exp(-(d * d) / (2 * PID.aspSigma * PID.aspSigma));
  }
  return sh;
}

function pidSizeScore(gi, e) {
  if (!gi.len) return 1;
  if (!e.sizeMm) return PID.szNoDb;
  const d = Math.abs(gi.len - e.sizeMm), s = PID.szA + PID.szB * e.sizeMm;
  return PID.szFloor + (1 - PID.szFloor) * Math.exp(-(d * d) / (2 * s * s));
}

function pidApp(gi, e) {
  return pidColorSim(gi.sg, e) * Math.pow(pidShapeScore(gi, e), PID.shapePow) * pidSizeScore(gi, e);
}

function pidReasons(gi, e) {
  const reasons = [];
  const cs = pidColorSim(gi.sg, e);
  const sh = pidShapeScore(gi, e);
  if (cs >= 0.9) reasons.push("colour match"); else if (cs >= 0.1) reasons.push("similar colour");
  if (sh >= 0.9) reasons.push("shape match"); else if (sh >= 0.35) reasons.push("similar shape");
  if (gi.len && e.sizeMm) {
    const d = Math.abs(gi.len - e.sizeMm);
    reasons.push(d <= 2 ? `size ${e.sizeMm} mm ≈ ${gi.len.toFixed(1)} mm` : `size ${e.sizeMm} mm vs ${gi.len.toFixed(1)} mm`);
  }
  return reasons;
}

function pidAka(e) {
  const gk = PID_GEN.get(e.genKey);
  const out = [];
  const own = new Set([e.name.toLowerCase(), e.generic.toLowerCase()]);
  if (e.brand) own.add(e.brand.toLowerCase());
  if (e.brand && !own.has(e.brand.toLowerCase())) out.push(e.brand);
  if (gk) [...gk.brands.entries()].sort((a, b) => b[1] - a[1]).forEach(([b]) => { if (!own.has(b.toLowerCase()) && !out.includes(b)) out.push(b); });
  if (e.brand && e.name.toLowerCase() !== e.generic.toLowerCase() && !out.includes(e.generic)) out.push(e.generic);
  return out.slice(0, 4);
}

function toResult(e, score, reasons, extra) {
  return {
    name: e.name, generic: e.generic, strength: e.strength, imprint: e.imprintText,
    colors: e.colors.slice(), shape: e.shape, sizeMm: e.sizeMm, labeler: e.labelers.slice(0, 3).join(", "),
    score: Math.max(0, Math.min(0.97, Math.round(score * 1000) / 1000)), reasons,
    id: e.i, brand: e.brand || undefined, alsoKnownAs: pidAka(e), ndc: e.ndc || undefined, rxcui: e.rxcui || undefined,
    form: e.form || undefined, ...(extra || {}),
  };
}

// One result per distinct drug+strength. Ranking value = (1-lam) * best matching appearance + lam * share-weighted mean over
// all appearances of that drug (a drug sold in forty looks is not "a perfect match" just because one look fits); a mild
// penalty for the 2nd, 3rd... candidate of the same generic keeps a shortlist from being five strengths of one drug.
function pidCollapse(sc, limit, lam) {
  const nI = PID_IDS.length, mx = new Float64Array(nI), sm = new Float64Array(nI), bi = new Int32Array(nI).fill(-1);
  for (let k = 0; k < sc.length; k++) {
    const v = sc[k];
    if (v <= 0) continue;
    const e = ENTRIES[k];
    sm[e.ix] += e.w * v;
    if (v > mx[e.ix]) { mx[e.ix] = v; bi[e.ix] = k; }
  }
  let list = [];
  for (let i = 0; i < nI; i++) if (bi[i] >= 0) list.push({ ix: i, k: bi[i], rank: (1 - lam) * mx[i] + lam * sm[i], shown: mx[i] });
  list.sort((a, b) => b.rank - a.rank);
  list = list.slice(0, Math.max(limit * 6, 40));
  const cnt = new Map();
  for (const it of list) {
    const gk = ENTRIES[it.k].genKey, n = cnt.get(gk) || 0;
    cnt.set(gk, n + 1);
    it.adj = it.rank * Math.pow(PID.variety, n);
  }
  list.sort((a, b) => b.adj - a.adj);
  const out = [];
  let prev = 1;
  for (const it of list) {
    if (out.length >= limit) break;
    const e = ENTRIES[it.k];
    it.e = e; it.score = Math.min(prev, it.shown); prev = it.score;
    it.variants = PID_IDS[it.ix].entries.length;
    out.push(it);
  }
  return out;
}

function pidAlts(it, sc) { // other looks of the same drug, best matches first
  return PID_IDS[it.ix].entries.filter((k) => k !== it.k && sc[k] > 0).sort((a, b) => sc[b] - sc[a]).slice(0, 3).map((k) => {
    const a = ENTRIES[k];
    return { imprint: a.imprintText, colors: a.colors.slice(), shape: a.shape, sizeMm: a.sizeMm, labeler: a.labelers.slice(0, 2).join(", ") };
  });
}

const pidSkipFn = (skip) => (skip == null ? null : typeof skip === "function" ? skip : (i) => skip.has(i));

export function identify(group, { mmPerPx = null, imprint = "", limit = 8, skip = null } = {}) {
  const gi = pidGroupInfo(group, mmPerPx);
  const typed = norm(imprint).length > 0;
  const Q = typed ? pidImQuery(imprint) : null;
  const skipFn = pidSkipFn(skip);
  let nameMap = null;
  if (typed) { // the imprint box also accepts a drug or brand name ("lipitor", "atorvastatin 20")
    const nm = pidNameScores(imprint, 0.8);
    if (nm && nm.best >= 0.85) nameMap = nm.map;
  }
  const sc = new Float64Array(ENTRIES.length), how = typed ? new Float64Array(ENTRIES.length) : null;
  for (let k = 0; k < ENTRIES.length; k++) {
    if (skipFn && skipFn(k)) continue;
    const e = ENTRIES[k];
    const app = pidApp(gi, e);
    const pr = (1 - PID.prior) + PID.prior * e.pop;
    let score;
    if (typed) {
      let m = imprintM(Q, e), viaName = 0;
      if (nameMap && m < 0.9) { const v = (nameMap.get(k) || 0) * 0.9; if (v > m) { m = v; viaName = 1; } }
      if (m > 0) { score = Math.pow(m, PID.imG) * (PID.imA + (1 - PID.imA) * Math.pow(app, PID.imB)) * (0.97 + 0.03 * pr); how[k] = viaName ? -m : m; }
      else score = PID.imMiss * app * pr;
    } else score = PID.cap * app * pr;
    sc[k] = score < 0.005 ? 0 : score;
  }
  return pidCollapse(sc, limit, typed ? 0 : PID.lam).map((x) => {
    const reasons = pidReasons(gi, x.e);
    if (typed && how[x.k] !== 0) reasons.unshift(how[x.k] < 0 ? "name matches" : pidHow(how[x.k]));
    return toResult(x.e, x.score, reasons, { variants: x.variants, alternates: pidAlts(x, sc) });
  });
}

// ---------- name / brand search ----------
// kinds: 1 = the product's own name or brand, 2 = its generic name, 3 = a brand name of the same drug (alias)
let PID_NAMES = null; // unique normalised name string -> {toks, w, kind, cov, ents:[entry index]}
function pidNameIndex() {
  if (PID_NAMES) return PID_NAMES;
  PID_NAMES = new Map();
  const add = (str, w, kind, k) => {
    const words = pidWords(str);
    const key = words.join(" ");
    if (!key) return;
    const id = key + "@" + kind;
    let r = PID_NAMES.get(id);
    if (!r) { r = { toks: words, w, kind, cov: words.filter((x) => !PID_SALT.has(x) && x !== "and" && x !== "with").length || 1, ents: [] }; PID_NAMES.set(id, r); }
    r.ents.push(k);
  };
  for (const e of ENTRIES) {
    const gk = PID_GEN.get(e.genKey);
    add(e.name, 1, 1, e.i);
    if (e.brand) add(e.brand, 1, 1, e.i);
    add(e.generic, 0.97, 2, e.i);
    if (gk) for (const b of gk.brands.keys()) add(b, 0.9, 3, e.i);
  }
  return PID_NAMES;
}

function pidTokSim(q, t) {
  if (q === t) return 1;
  const lq = q.length, lt = t.length;
  if (lq >= 3 && t.startsWith(q)) return 0.82 + 0.15 * (lq / lt);
  if (lt >= 4 && q.startsWith(t)) return 0.75;
  if (lq >= 4 && t.includes(q)) return 0.6;
  if (lq >= 4) {
    const max = lq >= 8 ? 2 : 1;
    const d = pidEd(q, t, max);
    if (d <= max) return d === 1 ? 0.85 : 0.7;
    if (lt > lq) { const dp = pidEd(q, t.slice(0, lq), 1); if (dp <= 1) return 0.7; } // typo in a partial word
  }
  return 0;
}

// -> {map: Map(entryIndex -> 0..1), kind: Map(entryIndex -> 1|2|3), best} or null when the text has no word to look for
function pidNameScores(text, minTok) {
  const words = pidWords(text);
  let qt = words.filter((w) => !/^\d/.test(w) && !/^(mg|mcg|ml|g)$/.test(w));
  const nums = words.filter((w) => /^\d/.test(w)).map((w) => w.replace(/[a-z]+$/, "")).filter(Boolean);
  const nonSalt = qt.filter((w) => !PID_SALT.has(w));
  if (nonSalt.length) qt = nonSalt;
  qt = qt.filter((w) => (w.length >= 3 || (qt.length > 1 && w.length >= 2)) && !/\d/.test(w));
  if (!qt.length || (!qt.some((w) => w.length >= 4) && qt.length < 2)) return null;
  const idx = pidNameIndex(), map = new Map(), kind = new Map();
  let best = 0;
  for (const r of idx.values()) {
    let sum = 0, ok = true;
    for (const q of qt) {
      let b = 0;
      for (const t of r.toks) { const v = pidTokSim(q, t); if (v > b) b = v; if (b === 1) break; }
      if (b < (minTok || 0.5)) { ok = false; break; }
      sum += b;
    }
    if (!ok) continue;
    const s = (sum / qt.length) * r.w * (0.85 + 0.15 * Math.min(1, qt.length / r.cov)); // a query that covers the whole name beats one that covers half of a combination
    for (const k of r.ents) {
      let v = s;
      if (nums.length) {
        const st = ENTRIES[k].strength.toLowerCase();
        v *= nums.every((n) => new RegExp("(^|[^0-9.])" + n.replace(".", "\.") + "([^0-9]|$)").test(st)) ? 1 : 0.6;
      }
      if (v > (map.get(k) || 0)) { map.set(k, v); kind.set(k, r.kind); }
    }
  }
  map.forEach((v) => { if (v > best) best = v; });
  return { map, kind, best };
}

export function searchName(text, { limit = 10, skip = null } = {}) {
  const nm = pidNameScores(text, 0.5);
  if (!nm) return [];
  const skipFn = pidSkipFn(skip);
  const sc = new Float64Array(ENTRIES.length), how = new Float64Array(ENTRIES.length);
  nm.map.forEach((v, k) => {
    if (skipFn && skipFn(k)) return;
    const s = v * (0.96 + 0.04 * ENTRIES[k].pop);
    if (s > 0.2) { sc[k] = s; how[k] = v; }
  });
  return pidCollapse(sc, limit, 0).map((x) => {
    const e = x.e, v = how[x.k], kd = nm.kind.get(x.k);
    const reasons = [v >= 0.93 ? "name matches" : v >= 0.75 ? "similar name" : "partial name match"];
    if (kd === 3) reasons.push(`generic equivalent of the name you typed (${e.generic})`);
    else if (kd === 2 && e.brand && e.name.toLowerCase() !== e.generic.toLowerCase()) reasons.push(`${e.brand} = ${e.generic}`);
    else if (kd === 1 && e.brand && e.brand.toLowerCase() !== e.generic.toLowerCase()) reasons.push(`${e.brand} = ${e.generic}`);
    return toResult(e, Math.min(0.95, x.score), reasons, { variants: x.variants });
  });
}

export function searchImprint(text, { limit = 10, skip = null } = {}) {
  const Q = pidImQuery(text);
  const skipFn = pidSkipFn(skip);
  const sc = new Float64Array(ENTRIES.length), how = new Float64Array(ENTRIES.length);
  for (let k = 0; k < ENTRIES.length; k++) {
    if (skipFn && skipFn(k)) continue;
    const m = imprintM(Q, ENTRIES[k]);
    if (m > 0) { sc[k] = m * (0.96 + 0.04 * ENTRIES[k].pop); how[k] = m; }
  }
  let res = pidCollapse(sc, limit, 0).map((x) => toResult(x.e, x.score, [pidHow(how[x.k])], { variants: x.variants }));
  // the imprint box also accepts a name: add name hits when imprints found nothing convincing
  if (!res.length || res[0].score < 0.7) {
    const nres = searchName(text, { limit, skip }).filter((r) => !res.some((x) => x.id === r.id));
    if (nres.length && nres[0].score >= 0.8) res = res.concat(nres).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return res;
}

export function describeGroup(group) {
  const cols = (group.colors && group.colors.length ? group.colors : []).join("/");
  const ds = detShape(group);
  const shapeWord = ds === "capsule" ? "" : ds || "";
  const noun = ds === "capsule" ? "capsule" : "tablet";
  const parts = [cols, shapeWord, noun].filter(Boolean).join(" ");
  return group.lengthMm ? `${parts}, ~${Math.round(group.lengthMm)} mm` : parts;
}
