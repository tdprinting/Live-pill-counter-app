// Pill identification: ranks FDA label appearances against a detected group, plus fuzzy imprint search.
import { PILL_DB } from "./pill-db.js";
import { colorSimilarity } from "./pillcv.js";

// ---------- imprint normalisation ----------
const CONFUSE = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", G: "6", Z: "2" };
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const canon = (s) => norm(s).replace(/[OQDILSBGZ]/g, (c) => CONFUSE[c]);

function lev1(a, b) { // true if edit distance <= 1
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; } else if (la > lb) i++; else j++;
  }
  return edits + (la - i) + (lb - j) <= 1;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  if (arr.length > 4) return [arr];
  const out = [];
  arr.forEach((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).forEach((p) => out.push([x, ...p])));
  return out;
}

// ---------- database prep (dedupe) ----------
const ENTRIES = [];
(function build() {
  const map = new Map();
  const labelerSets = new Map();
  for (const r of PILL_DB) {
    if (!labelerSets.has(r.query)) labelerSets.set(r.query, new Set());
    labelerSets.get(r.query).add(r.labeler);
    const sides = String(r.imprint || "").split(";").map((s) => s.trim()).filter(Boolean);
    const colors = [...(r.color || [])].map((c) => c.toLowerCase());
    const key = [[...r.ingredients].map((x) => x.toLowerCase()).sort().join("+"), r.strength, sides.map(norm).sort().join("|"),
      [...colors].sort().join("+"), r.shape].join("#");
    let e = map.get(key);
    if (!e) {
      const cs = sides.map(canon).filter(Boolean);
      e = {
        name: r.name, ingredients: r.ingredients, strength: r.strength, colors, shape: String(r.shape || "").toLowerCase(),
        sizeMm: r.sizeMm || null, query: r.query, imprintText: sides.join(" · "),
        perms: permutations(cs).map((p) => p.join("")), rawPerms: permutations(sides.map(norm).filter(Boolean)).map((p) => p.join("")), sides: cs, rawAll: sides.map(norm).join(""),
        labelers: [],
      };
      map.set(key, e); ENTRIES.push(e);
    }
    if (r.labeler && !e.labelers.includes(r.labeler)) e.labelers.push(r.labeler);
  }
  let max = 1;
  for (const s of labelerSets.values()) max = Math.max(max, s.size);
  for (const e of ENTRIES) e.prior = Math.log(1 + labelerSets.get(e.query).size) / Math.log(1 + max);
})();

// ---------- imprint matching: m in 0..1 ----------
function imprintMatch(text, e) {
  const q = norm(text);
  if (!q || !e.sides.length) return { m: 0, how: "" };
  const qc = canon(text);
  const tokens = String(text).toUpperCase().split(/[\s;,/·]+/).map(canon).filter(Boolean);
  if (e.rawPerms.includes(q)) return { m: 1, how: "imprint matches" };
  if (e.perms.includes(qc)) return { m: 0.9, how: "imprint matches (OCR-tolerant)" };
  if (e.sides.includes(qc)) return { m: 0.8, how: "imprint matches one side" };
  if (tokens.length > 1 && tokens.every((t) => e.sides.includes(t))) return { m: 0.92, how: "imprint matches" };
  if (tokens.length > 1 && tokens.every((t) => e.perms.some((p) => p.includes(t)))) return { m: 0.75, how: "imprint partly matches" };
  if (qc.length >= 3 && e.perms.some((p) => p.includes(qc))) return { m: 0.65, how: "imprint contained" };
  if (qc.length >= 4 && (e.perms.some((p) => lev1(p, qc)) || e.sides.some((s) => s.length >= 4 && lev1(s, qc)))) return { m: 0.55, how: "imprint similar" };
  if (qc.length >= 4 && e.perms.some((p) => p.length > qc.length && [...Array(p.length - qc.length + 1).keys()].some((i) => lev1(p.slice(i, i + qc.length), qc)))) return { m: 0.4, how: "imprint similar" };
  return { m: 0, how: "" };
}

// ---------- appearance ----------
const EXP_ASPECT = { round: 1, square: 1, diamond: 1.05, "double circle": 1, triangle: 1.1, oval: 1.5, capsule: 2.2, rectangle: 1.9, tear: 1.4, bullet: 1.8, "semi-circle": 1.6 };
function aspectExpect(shape) {
  if (EXP_ASPECT[shape] != null) return EXP_ASPECT[shape];
  if (/hexagon|pentagon|octagon/.test(shape)) return 1;
  return null;
}

function detShape(g) {
  if (g.shape) return g.shape;
  if (g.aspect) return g.aspect > 1.85 ? "capsule" : g.aspect > 1.13 ? "oval" : "round";
  return null;
}

function shapeSim(det, row) {
  if (!det) return 0.75;
  const t = {
    capsule: { capsule: 1, bullet: 0.6, oval: 0.5, rectangle: 0.45, tear: 0.3 },
    oval: { oval: 1, capsule: 0.5, tear: 0.5, egg: 0.5, rectangle: 0.3, bullet: 0.4, "semi-circle": 0.2, round: 0.15 },
    round: { round: 1, "double circle": 0.5, oval: 0.15 },
    "four-sided": { square: 1, diamond: 1, rectangle: 0.9, "four-sided": 1, trapezoid: 0.8, round: 0.2, oval: 0.1 },
    triangle: { triangle: 1, "semi-circle": 0.3, trapezoid: 0.2 },
  }[det] || {};
  if (t[row] != null) return t[row];
  if (det === "round" && /hexagon|pentagon|octagon/.test(row)) return 0.4;
  if (det === "four-sided" && /pentagon|hexagon/.test(row)) return 0.2;
  return 0.07;
}

function colorSim(g, rowColors) {
  const seen = (g.colors && g.colors.length ? g.colors : []).map((c) => c.toLowerCase());
  if (!seen.length) return 0.7;
  if (seen.length === 1) {
    if (rowColors.length === 1) return colorSimilarity(seen[0], rowColors[0]);
    return 0.12 * Math.max(...rowColors.map((c) => colorSimilarity(seen[0], c))) + 0.02; // one seen vs two-colour product
  }
  if (rowColors.length < 2) return 0.1 * Math.max(...seen.map((c) => colorSimilarity(c, rowColors[0]))) + 0.02;
  const a = colorSimilarity(seen[0], rowColors[0]) * colorSimilarity(seen[1], rowColors[1]);
  const b = colorSimilarity(seen[0], rowColors[1]) * colorSimilarity(seen[1], rowColors[0]);
  return Math.sqrt(Math.max(a, b));
}

function groupLengthMm(g, mmPerPx) {
  if (g.lengthMm) return g.lengthMm;
  const mp = mmPerPx || g.mmPerPx;
  if (g.lengthPx && mp) return g.lengthPx * mp;
  return null;
}

function appearance(g, e, lenMm) {
  const reasons = [];
  const cs = colorSim(g, e.colors);
  const ds = detShape(g);
  let sh = shapeSim(ds, e.shape);
  if (g.aspect && ds) {
    const ex = aspectExpect(e.shape);
    if (ex) {
      const d = Math.log(g.aspect / ex);
      sh *= 0.65 + 0.35 * Math.exp(-(d * d) / (2 * 0.28 * 0.28));
    }
  }
  let sz = 1;
  let sizeReason = null;
  if (lenMm && e.sizeMm) {
    const d = Math.abs(lenMm - e.sizeMm);
    sz = 0.1 + 0.9 * Math.exp(-(d * d) / (2 * 1.2 * 1.2));
    sizeReason = d <= 2 ? `size ${e.sizeMm} mm ≈ ${lenMm.toFixed(1)} mm` : `size ${e.sizeMm} mm vs ${lenMm.toFixed(1)} mm`;
  }
  if (cs >= 0.9) reasons.push("colour match"); else if (cs >= 0.3) reasons.push("similar colour");
  if (sh >= 0.9) reasons.push("shape match"); else if (sh >= 0.4) reasons.push("similar shape");
  if (sizeReason) reasons.push(sizeReason);
  return { app: cs * Math.pow(sh, 0.8) * sz, reasons };
}

function toResult(e, score, reasons) {
  return {
    name: e.name, generic: e.ingredients.join(" / "), strength: e.strength, imprint: e.imprintText,
    colors: e.colors.slice(), shape: e.shape, sizeMm: e.sizeMm, labeler: e.labelers.slice(0, 3).join(", "),
    score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)), reasons,
  };
}

// keep variety: at most 2 per generic+colour in the first pass
function diversify(items, limit) {
  const out = [], rest = [], seen = new Map();
  for (const it of items) {
    if (out.length >= limit) break;
    const k = it.e.ingredients.join("+") + "#" + it.e.colors.join("+");
    const n = seen.get(k) || 0;
    if (n < 2) { out.push(it); seen.set(k, n + 1); } else rest.push(it);
  }
  for (const it of rest) { if (out.length >= limit) break; out.push(it); }
  return out.sort((a, b) => b.score - a.score);
}

export function identify(group, { mmPerPx = null, imprint = "", limit = 8 } = {}) {
  const lenMm = groupLengthMm(group, mmPerPx);
  const typed = norm(imprint).length > 0;
  const scored = [];
  for (const e of ENTRIES) {
    const { app, reasons } = appearance(group, e, lenMm);
    let score, rs = reasons;
    const pr = 0.85 + 0.15 * e.prior;
    if (typed) {
      const im = imprintMatch(imprint, e);
      if (im.m > 0) { score = Math.min(0.97, (0.5 * im.m + 0.45 * im.m * app) * (0.97 + 0.03 * e.prior)); rs = [im.how, ...reasons]; }
      else score = 0.18 * app * pr;
    } else score = 0.6 * app * pr;
    if (score < 0.005) continue;
    scored.push({ e, score, reasons: rs });
  }
  scored.sort((a, b) => b.score - a.score);
  return diversify(scored, limit).map((x) => toResult(x.e, x.score, x.reasons));
}

export function searchImprint(text, { limit = 10 } = {}) {
  const out = [];
  for (const e of ENTRIES) {
    const im = imprintMatch(text, e);
    if (im.m <= 0) continue;
    out.push({ e, score: Math.min(0.97, im.m * (0.96 + 0.04 * e.prior)), reasons: [im.how] });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map((x) => toResult(x.e, x.score, x.reasons));
}

export function describeGroup(group) {
  const cols = (group.colors && group.colors.length ? group.colors : []).join("/");
  const ds = detShape(group);
  const shapeWord = ds === "capsule" ? "" : ds || "";
  const noun = ds === "capsule" ? "capsule" : "tablet";
  const parts = [cols, shapeWord, noun].filter(Boolean).join(" ");
  return group.lengthMm ? `${parts}, ~${Math.round(group.lengthMm)} mm` : parts;
}
