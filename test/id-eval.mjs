// Simulation harness for the pill identifier (src/pill-id.js).
//
// For DB rows it simulates what the camera + vision engine would report (colour confusions, shape confusions,
// noisy / missing size, two-tone errors, typed imprints with typos), runs identify(), and measures how often the
// right drug+strength is #1 / in the top 5 / in the top 10.  It is a SIMULATION: it models camera noise, it is not
// a set of real photographs (see test/ID-RESULTS.md for the limits).
//
//   node test/id-eval.mjs                       evaluate src/pill-id.js on src/pill-db.js
//   node test/id-eval.mjs --n 4000 --seed 7     more / different samples
//   node test/id-eval.mjs --noise 2             stress test: double the confusion rates, less size data
//   node test/id-eval.mjs --module X --db Y     evaluate another identifier / database (before-and-after comparisons)
//   node test/id-eval.mjs --tune                coordinate-descent tuning of pill-id.js parameters (tune half / test half)
//   node test/id-eval.mjs --json out.json       also write the numbers
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true); };
const N = +opt("n", 3000), SEED = +opt("seed", 1337), NOISE = +opt("noise", 1);
const modPath = resolve(opt("module", resolve(here, "../src/pill-id.js")));
const dbPath = resolve(opt("db", resolve(here, "../src/pill-db.js")));
const TUNE = !!opt("tune", false);
const BY = opt("by", "row");

// ---------- helpers ----------
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let rnd = mulberry32(SEED);
const pick = (dist) => { // dist: {key: prob}
  let tot = 0; for (const k in dist) tot += dist[k];
  let r = rnd() * tot;
  for (const k in dist) { r -= dist[k]; if (r <= 0) return k; }
  return Object.keys(dist)[0];
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

// ---------- DB decoding (works for the v2 compact format and the old array-of-objects format) ----------
const dbMod = await import(pathToFileURL(dbPath).href);
const RAW = dbMod.PILL_DB;
function decode(D) {
  if (Array.isArray(D)) return D.map((r) => ({ name: r.name, generic: r.ingredients.join(" / "), strength: r.strength, imprint: r.imprint, colors: r.color.map((c) => c.toLowerCase()), shape: String(r.shape || "").toLowerCase(), sizeMm: r.sizeMm || null, form: r.form || "", labelers: [r.labeler] }));
  return D.R.map((r) => ({ name: D.S[r[0]], generic: D.S[r[1]], strength: D.S[r[2]], imprint: r[3], colors: D.C[r[4]].map((c) => c.toLowerCase()), shape: String(D.H[r[5]] || "").toLowerCase(), sizeMm: r[6] ? r[6] / 10 : null, form: D.S[r[11]] || "", labelers: r[7].map((i) => D.L[i]) }));
}
const ROWS = decode(RAW);

// identity used for "hit": active ingredient(s) + strength, any labeler (salts ignored: atorvastatin calcium = atorvastatin)
const SALT = new Set("hydrochloride hcl sodium potassium calcium magnesium besylate maleate tartrate succinate bitartrate sulfate phosphate mesylate fumarate citrate hydrobromide acetate medoxomil anhydrous monohydrate dihydrate hemihydrate trihydrate bromide chloride nitrate carbonate oxide hydrate disodium dipropionate propionate valerate lactate gluconate pamoate mononitrate dinitrate saccharate aspartate dihydrochloride cypionate bisulfate hemifumarate tosylate dimesylate decanoate hyclate monosodium sesquihydrate propanediol propylene glycol solvate cilexetil axetil mofetil etexilate disoproxil alafenamide benzoate stearate xinafoate pivoxil proxetil tromethamine besilate malate oxalate napsylate pidolate orotate edisylate meglumine dimeglumine hydroxide".split(" "));
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const gk = (n) => { const w = words(n), k = w.filter((x) => !SALT.has(x)); return (k.length ? k : w).join(" "); };
const amt = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
function identity(generic, strength) {
  const ings = String(generic).split(" / "), amts = String(strength).split(" / ");
  const pairs = ings.length === amts.length ? ings.map((g, i) => gk(g) + "=" + amt(amts[i])) : ings.map(gk).concat(["~" + amt(strength)]);
  return pairs.sort().join("+");
}
const genericKey = (generic) => String(generic).split(" / ").map(gk).sort().join("+");
ROWS.forEach((r, i) => { r.i = i; r.id = identity(r.generic, r.strength); r.gen = genericKey(r.generic); });
const ID_COUNT = new Map(); ROWS.forEach((r) => ID_COUNT.set(r.id, (ID_COUNT.get(r.id) || 0) + 1));

// ---------- camera / vision-engine simulation ----------
// P(engine colour | true SPL colour). Off-diagonal mass is multiplied by NOISE (stress test).
const CONF = {
  white: { white: 0.84, gray: 0.08, yellow: 0.05, pink: 0.02, turquoise: 0.005, blue: 0.005 },
  yellow: { yellow: 0.80, white: 0.06, orange: 0.10, green: 0.02, brown: 0.02 },
  orange: { orange: 0.72, yellow: 0.10, red: 0.06, brown: 0.07, pink: 0.05 },
  pink: { pink: 0.76, red: 0.07, orange: 0.05, white: 0.07, purple: 0.03, brown: 0.02 },
  red: { red: 0.78, pink: 0.08, orange: 0.07, brown: 0.07 },
  brown: { brown: 0.74, orange: 0.12, red: 0.06, black: 0.04, gray: 0.02, yellow: 0.02 },
  green: { green: 0.82, turquoise: 0.10, yellow: 0.03, blue: 0.02, gray: 0.03 },
  turquoise: { turquoise: 0.66, blue: 0.16, green: 0.14, white: 0.02, gray: 0.02 },
  blue: { blue: 0.76, turquoise: 0.12, purple: 0.07, gray: 0.03, green: 0.02 },
  purple: { purple: 0.72, blue: 0.12, pink: 0.10, gray: 0.04, brown: 0.02 },
  gray: { gray: 0.74, white: 0.13, black: 0.08, blue: 0.03, brown: 0.02 },
  black: { black: 0.83, gray: 0.10, brown: 0.05, blue: 0.01, purple: 0.01 },
};
function seeColor(c) {
  const row = CONF[c];
  if (!row) return c;
  const d = {};
  for (const k in row) d[k] = k === c ? row[k] : row[k] * NOISE;
  return pick(d);
}
// P(engine class | true SPL shape)
const SHAPE_CONF = {
  round: { round: 0.85, "four-sided": 0.05, oval: 0.10 },
  oval: { oval: 0.72, capsule: 0.18, round: 0.08, "four-sided": 0.02 },
  capsule: { capsule: 0.80, oval: 0.18, "four-sided": 0.02 },
  square: { "four-sided": 0.75, round: 0.15, oval: 0.10 },
  diamond: { "four-sided": 0.80, oval: 0.10, round: 0.10 },
  rectangle: { "four-sided": 0.35, capsule: 0.35, oval: 0.30 },
  triangle: { triangle: 0.85, "four-sided": 0.10, round: 0.05 },
  bullet: { oval: 0.45, capsule: 0.40, round: 0.15 },
  tear: { oval: 0.60, capsule: 0.20, round: 0.20 },
  hexagon: { round: 0.60, "four-sided": 0.25, oval: 0.15 }, pentagon: { round: 0.60, "four-sided": 0.25, oval: 0.15 },
  octagon: { round: 0.60, "four-sided": 0.25, oval: 0.15 }, heptagon: { round: 0.60, "four-sided": 0.25, oval: 0.15 },
  "semi-circle": { oval: 0.50, round: 0.20, "four-sided": 0.20, capsule: 0.10 },
  "double circle": { oval: 0.50, capsule: 0.30, round: 0.20 },
  trapezoid: { "four-sided": 0.60, oval: 0.20, capsule: 0.20 },
};
const SHAPE_OTHER = { round: 0.5, oval: 0.3, "four-sided": 0.2 };
const TYP_ASPECT = { round: 1.0, "four-sided": 1.05, triangle: 1.1, oval: 1.5, capsule: 2.2 };
const TRUE_ASPECT = { round: 1, square: 1, diamond: 1.05, "double circle": 1.6, triangle: 1.1, oval: 1.5, capsule: 2.3, rectangle: 1.9, tear: 1.4, bullet: 1.9, "semi-circle": 1.7, hexagon: 1.03, pentagon: 1.03, octagon: 1.02, heptagon: 1.02, trapezoid: 1.3 };

function simulateGroup(row) {
  const g = { count: 1, role: "pill", rgb: [200, 200, 200], halvesRgb: null, twoTone: false, colors: [], shape: null, aspect: null, lengthPx: null, lengthMm: null };
  const cols = row.colors.slice(0, 2);
  let seen;
  if (cols.length === 2) {
    const r = rnd();
    if (r < 0.88) seen = cols.map(seeColor);
    else if (r < 0.98) seen = [seeColor(cols[rnd() < 0.5 ? 0 : 1])];
    else seen = [seeColor(cols[0]), seeColor(cols[0])];
  } else {
    seen = [seeColor(cols[0])];
    if (rnd() < 0.03 * NOISE) { // false two-tone
      const near = Object.keys(CONF[cols[0]] || {}).filter((k) => k !== cols[0]);
      if (near.length) seen.push(near[Math.floor(rnd() * near.length)]);
    }
  }
  if (seen.length === 2 && seen[0] === seen[1]) seen = [seen[0]];
  if (rnd() < 0.5) seen.reverse();
  g.colors = seen; g.twoTone = seen.length === 2;
  if (rnd() >= 0.10 * NOISE) {
    const conf = SHAPE_CONF[row.shape] || SHAPE_OTHER;
    const cls = pick(conf);
    g.shape = cls;
    const base = rnd() < 0.5 && TRUE_ASPECT[row.shape] ? TRUE_ASPECT[row.shape] : TYP_ASPECT[cls];
    g.aspect = Math.max(1, base * Math.exp(0.10 * gauss()));
  }
  if (row.sizeMm && rnd() >= Math.min(0.9, 0.5 + 0.2 * (NOISE - 1))) g.lengthMm = row.sizeMm * (1 + (rnd() * 2 - 1) * 0.08 * NOISE);
  return g;
}

const OCR = { O: "0", 0: "O", I: "1", 1: "I", L: "1", S: "5", 5: "S", B: "8", 8: "B", G: "6", 6: "G", Z: "2", 2: "Z", D: "0" };
function typeImprint(row, error) {
  const sides = row.imprint.split(";").map((s) => s.trim()).filter(Boolean);
  let txt = sides.join(rnd() < 0.6 ? " " : "");
  if (rnd() < 0.5) txt = txt.toLowerCase();
  if (!error) return txt;
  const chars = txt.replace(/[^A-Za-z0-9]/g, "").toUpperCase().split("");
  if (!chars.length) return txt;
  const p = Math.floor(rnd() * chars.length), r = rnd();
  const alnum = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
  if (r < 0.40) chars[p] = (OCR[chars[p]] && rnd() < 0.6) ? OCR[chars[p]] : alnum[Math.floor(rnd() * alnum.length)];
  else if (r < 0.60 && chars.length > 1) chars.splice(p, 1);
  else if (r < 0.80) chars.splice(p, 0, alnum[Math.floor(rnd() * alnum.length)]);
  else if (chars.length > 1) { const q = Math.min(chars.length - 1, p + 1); [chars[p], chars[q]] = [chars[q], chars[p]]; }
  else chars[p] = alnum[Math.floor(rnd() * alnum.length)];
  return chars.join("");
}

// ---------- evaluation ----------
const mod = await import(pathToFileURL(modPath).href);
const HAS_SKIP = typeof mod.pidEntries === "function";
const rankOf = (res, truthId) => { for (let i = 0; i < res.length; i++) if (identity(res[i].generic, res[i].strength) === truthId) return i + 1; return 0; };

// by "row": every appearance equally likely (the literal hold-out protocol; favours drugs with many looks)
// by "id":  every drug+strength equally likely, then a random one of its looks (neutral about how many looks a drug has)
function sampleRows(n, filter, by = BY) {
  let idx = ROWS.map((_, i) => i).filter((i) => !filter || filter(ROWS[i]));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  if (by === "id") {
    const g = new Map();
    for (const i of idx) { const l = g.get(ROWS[i].id) || []; l.push(i); g.set(ROWS[i].id, l); }
    idx = shuffle([...g.values()].map((l) => l[Math.floor(rnd() * l.length)]));
  } else shuffle(idx);
  return idx.slice(0, Math.min(n, idx.length)).map((i) => ROWS[i]);
}

// Pre-generate the simulated camera/typing inputs once so that tuning compares parameters on identical inputs.
function makeTrials(rows) {
  return rows.map((r) => ({ row: r, g: simulateGroup(r), g2: simulateGroup(r), exact: typeImprint(r, false), err: typeImprint(r, true) }));
}

const SCEN = ["app", "appUnseen", "imp", "impErr"];
function runTrial(t, scen, lim = 10) {
  const r = t.row;
  if (scen === "app") return rankOf(mod.identify(t.g, { limit: lim }), r.id);
  if (scen === "appUnseen") return HAS_SKIP ? rankOf(mod.identify(t.g, { limit: lim, skip: new Set([r.i]) }), r.id) : -1;
  if (scen === "imp") return rankOf(mod.identify(t.g2, { limit: lim, imprint: t.exact }), r.id);
  return rankOf(mod.identify(t.g2, { limit: lim, imprint: t.err }), r.id);
}
const summarize = (ranks) => {
  const v = ranks.filter((x) => x >= 0), n = v.length || 1;
  return { n: v.length, top1: v.filter((x) => x === 1).length / n, top5: v.filter((x) => x > 0 && x <= 5).length / n, top10: v.filter((x) => x > 0 && x <= 10).length / n };
};
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";

function evaluate(trials, scens = SCEN) {
  const out = {};
  for (const s of scens) {
    const ranks = [];
    for (const t of trials) {
      if (s === "appUnseen" && ID_COUNT.get(t.row.id) < 2) { ranks.push(-1); continue; } // no other appearance of this drug in the DB
      ranks.push(runTrial(t, s));
    }
    out[s] = { ...summarize(ranks), ranks };
  }
  return out;
}

if (!TUNE) {
  const t0 = Date.now();
  const rows = sampleRows(N);
  const trials = makeTrials(rows);
  const res = evaluate(trials);
  console.log(`\nIdentifier: ${modPath}\nDatabase:   ${dbPath}  (${ROWS.length} appearances, ${ID_COUNT.size} distinct drug+strength, ${new Set(ROWS.map((r) => r.gen)).size} drugs)`);
  console.log(`Simulation: ${rows.length} sampled ${BY === "id" ? "drug+strengths (one random look each)" : "appearances"}, seed ${SEED}, noise x${NOISE}, ~50% of trials without size, 10% unknown shape\n`);
  console.log("scenario                                       n    top1    top5   top10");
  const label = { app: "(a) appearance only, pill in database", appUnseen: "(a') appearance only, THIS version held out", imp: "(b) appearance + correct imprint typed", impErr: "(c) appearance + imprint with 1 typo" };
  for (const s of SCEN) {
    const r = res[s];
    if (r.n === 0) { console.log(label[s].padEnd(44), "n/a"); continue; }
    console.log(label[s].padEnd(44), String(r.n).padStart(5), pct(r.top1), pct(r.top5), pct(r.top10));
  }

  // size known (camera calibrated) versus size unknown
  const bySize = {};
  for (const [lab, want] of [["size measured", true], ["no size", false]]) {
    const pick = (sc, g) => summarize(trials.map((t, i) => ((!!t[g].lengthMm) === want ? res[sc].ranks[i] : null)).filter((x) => x !== null));
    bySize[lab] = { app: pick("app", "g"), appUnseen: pick("appUnseen", "g"), imp: pick("imp", "g2"), impErr: pick("impErr", "g2") };
    console.log(`  ${lab.padEnd(14)} appearance-only top5 ${pct(bySize[lab].app.top5)} (top1 ${pct(bySize[lab].app.top1)}, n=${bySize[lab].app.n})   held-out version top5 ${pct(bySize[lab].appUnseen.top5)}   with imprint top1 ${pct(bySize[lab].imp.top1)}   1-typo top1 ${pct(bySize[lab].impErr.top1)}`);
  }

  // breakdown by true colour / shape (appearance only, top-5)
  const byClass = (keyFn, title) => {
    const m = new Map();
    trials.forEach((t, i) => { const k = keyFn(t.row); const a = m.get(k) || { n: 0, h5: 0, h1: 0, i1: 0, ie: 0 }; a.n++; const rk = res.app.ranks[i]; if (rk > 0 && rk <= 5) a.h5++; if (rk === 1) a.h1++; if (res.imp.ranks[i] === 1) a.i1++; if (res.impErr.ranks[i] === 1) a.ie++; m.set(k, a); });
    console.log(`\n${title}\n${"class".padEnd(22)}   n   app top5   app top1   imprint top1   typo top1`);
    [...m.entries()].filter(([, a]) => a.n >= 8).sort((a, b) => b[1].n - a[1].n).slice(0, 16).forEach(([k, a]) => console.log(String(k).padEnd(22), String(a.n).padStart(4), pct(a.h5 / a.n).padStart(10), pct(a.h1 / a.n).padStart(10), pct(a.i1 / a.n).padStart(13), pct(a.ie / a.n).padStart(12)));
    return Object.fromEntries([...m.entries()].map(([k, a]) => [k, { n: a.n, top5: a.h5 / a.n, top1: a.h1 / a.n, impTop1: a.i1 / a.n, typoTop1: a.ie / a.n }]));
  };
  const byColor = byClass((r) => r.colors.join("/"), "By colour (true label colour)");
  const byShape = byClass((r) => r.shape, "By shape (true label shape)");

  // look-alike clusters in the DB itself: same colour(s) + shape + size within 1 mm, different drug+strength
  const cl = new Map();
  for (const r of ROWS) {
    const k = [r.colors.slice().sort().join("/"), r.shape, r.sizeMm ? Math.round(r.sizeMm) : "?"].join(" | ");
    const e = cl.get(k) || { ids: new Map() }; e.ids.set(r.id, r); cl.set(k, e);
  }
  const clusters = [...cl.entries()].filter(([k]) => !k.endsWith("?")).map(([k, e]) => ({ key: k, drugs: e.ids.size, example: [...e.ids.values()].slice(0, 4).map((r) => `${r.name} ${r.strength}`) })).sort((a, b) => b.drugs - a.drugs);
  console.log("\nBiggest look-alike clusters (same colour + shape + size to the nearest mm, different drug+strength):");
  clusters.slice(0, 12).forEach((c) => console.log(`  ${String(c.drugs).padStart(4)} drugs  ${c.key}   e.g. ${c.example.join("; ")}`));

  // look-alike groups that matter most: clusters (colour + shape + size to 1 mm) holding a controlled substance next to other drugs
  const CTRL_RE = /oxycodone|hydrocodone|tramadol|alprazolam|lorazepam|clonazepam|diazepam|zolpidem|amphetamine|methylphenidate|buprenorphine|morphine|hydromorphone|tapentadol|oxymorphone|methadone|codeine|temazepam|carisoprodol|phentermine/;
  const cc = new Map();
  for (const r of ROWS) {
    if (!r.sizeMm) continue;
    const k = [r.colors.slice().sort().join("/"), r.shape, Math.round(r.sizeMm)].join(" | ");
    const e = cc.get(k) || { ctrl: new Map(), other: new Set() };
    if (CTRL_RE.test(r.generic.toLowerCase())) e.ctrl.set(r.id, r); else e.other.add(r.id);
    cc.set(k, e);
  }
  const ctrlClusters = [...cc.entries()].filter(([, e]) => e.ctrl.size).map(([k, e]) => ({ key: k, controlled: e.ctrl.size, others: e.other.size, example: [...e.ctrl.values()].slice(0, 3).map((r) => `${r.name} ${r.strength}`) })).sort((a, b) => b.controlled + b.others - (a.controlled + a.others));
  console.log("\nLook-alike groups containing a controlled substance (same colour + shape + size to the nearest mm):");
  ctrlClusters.slice(0, 8).forEach((c) => console.log(`  ${String(c.controlled).padStart(3)} controlled + ${String(c.others).padStart(3)} other drug+strengths  ${c.key}   e.g. ${c.example.join("; ")}`));

  // drugs that most often swallow the right answer: what was #1 when the truth was missed in the top 5?
  const wrong = new Map();
  trials.forEach((t, i) => { const rk = res.app.ranks[i]; if (rk > 0 && rk <= 5) return; const top = mod.identify(t.g, { limit: 1 })[0]; if (top) { const k = `${top.name} ${top.strength}`; wrong.set(k, (wrong.get(k) || 0) + 1); } });
  const magnets = [...wrong.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("\nMost frequent wrong #1 answers (appearance only): " + magnets.map(([k, n]) => `${k} (${n})`).join("; "));

  // hardest controlled / look-alike-sensitive pills
  const CTRL = /oxycodone|hydrocodone|tramadol|alprazolam|lorazepam|clonazepam|diazepam|zolpidem|amphetamine|methylphenidate|buprenorphine|morphine|hydromorphone|tapentadol/;
  const ct = trials.map((t, i) => ({ t, i })).filter(({ t }) => CTRL.test(t.row.generic.toLowerCase()));
  if (ct.length) {
    const s = (sc) => summarize(ct.map(({ i }) => res[sc].ranks[i]));
    console.log(`\nControlled substances in sample (n=${ct.length}): appearance top5 ${pct(s("app").top5)}, imprint top1 ${pct(s("imp").top1)}, typo top1 ${pct(s("impErr").top1)}`);
  }
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const jf = opt("json", false);
  if (jf) {
    const strip = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, top1: v.top1, top5: v.top5, top10: v.top10 }]));
    writeFileSync(jf, JSON.stringify({ module: modPath, db: dbPath, rows: ROWS.length, identities: ID_COUNT.size, sampled: rows.length, seed: SEED, noise: NOISE, results: strip(res), bySize: Object.fromEntries(Object.entries(bySize).map(([k, v]) => [k, strip(v)])), byColor, byShape, clusters: clusters.slice(0, 25), ctrlClusters: ctrlClusters.slice(0, 15), magnets }, null, 1));
  }
} else {
  // ---------- tuning: coordinate descent on the "tune" half of the drugs, reported on the other half ----------
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  const isTune = (r) => hash(r.gen) % 2 === 0;
  const tn = +opt("tn", 400);
  const tuneTrials = [...makeTrials(sampleRows(tn, isTune, "row")), ...makeTrials(sampleRows(tn, isTune, "id"))];
  const testTrials = [...makeTrials(sampleRows(tn, (r) => !isTune(r), "row")), ...makeTrials(sampleRows(tn, (r) => !isTune(r), "id"))];
  const J = (res) => res.app.top5 + 0.5 * res.appUnseen.top5 + res.imp.top1 + 0.5 * res.impErr.top1;
  const fmt = (r) => `app top5 ${pct(r.app.top5)} unseen top5 ${pct(r.appUnseen.top5)} imp top1 ${pct(r.imp.top1)} typo top1 ${pct(r.impErr.top1)}`;
  const SPACE = {
    near: [0.5, 0.75, 1, 1.5, 2, 3], floorC: [0.005, 0.01, 0.02, 0.04, 0.08], twoMiss: [0.05, 0.12, 0.25], twoSpur: [0.02, 0.06, 0.15],
    shapeCross: [0.6, 0.8, 1, 1.3, 1.8], shapeUnknown: [0.5, 0.8, 1], shapePow: [0.5, 0.8, 1, 1.3], aspSigma: [0.15, 0.2, 0.28, 0.4, 0.6], aspMin: [0.3, 0.5, 0.65, 0.85, 1],
    szA: [0.2, 0.4, 0.6, 0.9], szB: [0.02, 0.05, 0.08, 0.12], szFloor: [0.02, 0.05, 0.08, 0.15, 0.3], szNoDb: [0.3, 0.6, 0.9],
    prior: [0, 0.1, 0.25, 0.45, 0.7], lam: [0, 0.15, 0.3, 0.5, 0.75, 1], variety: [1, 0.96, 0.93, 0.88, 0.8, 0.7], imA: [0.3, 0.4, 0.5, 0.6, 0.75], imMiss: [0.1, 0.18, 0.3], fzBase: [0.25, 0.32, 0.4, 0.5, 0.6], fzSlope: [0, 0.04, 0.08, 0.12], mContain: [0.5, 0.58, 0.65, 0.75], mSide: [0.7, 0.8, 0.88], imG: [0.5, 0.75, 1, 1.5, 2.5], imB: [0.5, 0.75, 1, 1.5],
  };
  const base0 = mod.pidGetParams();
  console.log("start params:", JSON.stringify(base0));
  let cur = { ...base0 };
  const t0 = Date.now();
  const startRes = evaluate(tuneTrials);
  let curJ = J(startRes);
  console.log("tune-half  start:", fmt(startRes), "J=", curJ.toFixed(4));
  const startTest = evaluate(testTrials);
  console.log("held-out half start:", fmt(startTest));
  const only = opt("only", false) ? String(opt("only")).split(",") : null;
  for (let pass = 0; pass < +opt("passes", 2); pass++) {
    let improved = false;
    for (const key of Object.keys(SPACE)) {
      if (only && !only.includes(key)) continue;
      let bestV = cur[key], bestJ = curJ;
      for (const v of SPACE[key]) {
        if (v === cur[key]) continue;
        mod.pidSetParams({ ...cur, [key]: v });
        const j = J(evaluate(tuneTrials));
        if (j > bestJ + 1e-9) { bestJ = j; bestV = v; }
      }
      if (bestV !== cur[key]) { cur[key] = bestV; curJ = bestJ; improved = true; console.log(`  pass ${pass + 1}: ${key} = ${bestV}  J=${curJ.toFixed(4)}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
      mod.pidSetParams(cur);
    }
    if (!improved) break;
  }
  mod.pidSetParams(cur);
  console.log("\nTUNED params:", JSON.stringify(cur));
  console.log("tune-half  end:  ", fmt(evaluate(tuneTrials)));
  console.log("held-out half end:", fmt(evaluate(testTrials)), "(drugs the tuner never saw)");
}
