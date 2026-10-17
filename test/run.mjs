// Accuracy benchmark: renders many synthetic tray photos across lighting / tray /
// layout / pill-type conditions and scores the engine against ground truth.
//   node test/run.mjs            full matrix
//   node test/run.mjs quick      smaller matrix
//   node test/run.mjs dump       also writes annotated PNGs to test/out
import { analyze } from "../src/pillcv.js";
import { placePills, render, rng, writePNG } from "./synth.mjs";
import fs from "node:fs";

const args = process.argv.slice(2);
const QUICK = args.includes("quick"), DUMP = args.includes("dump"), FAST = args.includes("fast");
const only = args.find((a) => a.startsWith("only="))?.slice(5);
const W = 800, H = 600;

const PILLSETS = [
  { main: "whiteRound", odd: ["peachRound"] },
  { main: "yellowOval", odd: ["whiteOval"] },
  { main: "capsuleRedWh", odd: ["capsuleBlueWh"] },
  { main: "whiteOblong", odd: ["whiteOval"] },
  { main: "blueRound", odd: ["greenRound"] },
  { main: "pinkOval", odd: ["orangeRound"] },
  { main: "whiteSmall", odd: ["whiteRound"] }, // same colour, ~33% bigger
  { main: "capsuleYellow", odd: ["yellowOval"] }, // same colour, different shape
];
const BGS = ["blueTray", "whitePlate", "blackTray", "grayTray", "beigeCounter"];
const LIGHTS = ["even", "dim", "veryDim", "sideLight", "warm", "cool", "harsh", "overhead"];
const LAYOUTS = ["spread", "touching", "overlap", "pile"];

const stats = {}; // key -> {n, exact, absErr, oddHit, oddN, falseFlags}
const add = (key, rec) => {
  const s = (stats[key] ||= { n: 0, exact: 0, within1: 0, absErr: 0, oddHit: 0, oddN: 0, falseFlag: 0, ms: 0, brokenN: 0, brokenHit: 0, inRange: 0, conf: 0, confExact: 0, confWrong: 0, nWrong: 0 });
  s.brokenN += rec.brokenN; s.brokenHit += rec.brokenHit; s.inRange += rec.inRange; s.conf += rec.conf;
  if (rec.err === 0) s.confExact += rec.conf; else { s.confWrong += rec.conf; s.nWrong++; }
  s.n++; s.exact += rec.err === 0; s.within1 += Math.abs(rec.err) <= 1; s.absErr += Math.abs(rec.err);
  if (rec.oddN) { s.oddN++; s.oddHit += rec.oddHit; }
  s.falseFlag += rec.falseFlag; s.ms += rec.ms;
};

if (DUMP) fs.mkdirSync("test/out", { recursive: true });
let seed = 1, failures = [];
for (const set of PILLSETS) for (const bg of BGS) for (const light of LIGHTS) for (const layout of LAYOUTS) {
  if (QUICK && rng(seed * 2654435761 % 4294967291)() > 0.3) { seed++; continue; }
  const key = `${set.main}|${bg}|${light}|${layout}`;
  if (only && !key.includes(only)) { seed++; continue; }
  const r = rng(seed);
  const pxPerMm = 3 + r() * 1.6; // phone 20–35 cm above the tray
  const count = 12 + Math.floor(r() * 30);
  const withOdd = seed % 2 === 0;
  const nBroken = layout === "spread" && seed % 3 === 0 ? 1 + (seed % 2) : 0;
  const all = placePills({ main: set.main, count, odd: withOdd ? set.odd : [], layout, broken: nBroken }, r, W, H, pxPerMm);
  const pills = all.filter((p) => !p.broken), brokenTruth = all.filter((p) => p.broken);
  const rgba = render(all, { W, H, bg, light }, seed);
  const res = analyze(rgba, W, H, { fast: FAST });
  const truth = pills.length;
  const err = res.total - truth;
  // odd detection: is there a pill flagged non-primary near the odd pill's location?
  const oddTruth = pills.filter((p) => p.odd);
  let oddHit = 0, falseFlag = 0;
  const flagged = res.pills.filter((p) => p.group > 0);
  for (const o of oddTruth) if (flagged.some((f) => Math.hypot(f.x - o.x, f.y - o.y) < Math.max(o.widPx, 10))) oddHit = 1;
  for (const f of flagged) if (!oddTruth.some((o) => Math.hypot(f.x - o.x, f.y - o.y) < Math.max(o.lenPx * 0.6, 10))) falseFlag++;
  const brokenHit = brokenTruth.filter((b) => res.fragments.some((f) => Math.hypot(f.x - b.x, f.y - b.y) < b.lenPx * 0.6)).length;
  const inRange = truth >= res.range[0] && truth <= res.range[1];
  const rec = { err, oddN: oddTruth.length, oddHit, falseFlag, ms: res.ms, brokenN: brokenTruth.length, brokenHit, inRange, conf: res.confidence };
  for (const k of ["ALL", "set:" + set.main, "bg:" + bg, "light:" + light, "layout:" + layout]) add(k, rec);
  if (err !== 0 || (oddTruth.length && !oddHit) || falseFlag) failures.push({ key, seed, truth, got: res.total, range: res.range, oddHit: oddTruth.length ? oddHit : "-", falseFlag, warn: res.warnings.join(",") });
  if (DUMP && (err !== 0 || falseFlag || (oddTruth.length && !oddHit))) dump(`test/out/${seed}-${key.replace(/\|/g, "_")}.png`, rgba, res, pills);
  seed++;
}

function dump(path, rgba, res, truth) {
  const img = new Uint8ClampedArray(rgba);
  const dot = (x, y, col, rad) => { for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { const X = Math.round(x + dx), Y = Math.round(y + dy); if (X < 0 || Y < 0 || X >= W || Y >= H || dx * dx + dy * dy > rad * rad) continue; const i = (Y * W + X) * 4; img[i] = col[0]; img[i + 1] = col[1]; img[i + 2] = col[2]; } };
  for (const t of truth) dot(t.x, t.y, [0, 255, 0], 2);
  for (const p of res.pills) dot(p.x, p.y, p.group > 0 ? [255, 0, 255] : p.conf === "high" ? [255, 0, 0] : [255, 160, 0], 4);
  writePNG(path, img, W, H);
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "  -  ");
const rows = Object.entries(stats);
const hdr = ["condition".padEnd(26), "n".padStart(4), "exact".padStart(7), "±1".padStart(7), "in range".padStart(9), "MAE".padStart(6), "odd caught".padStart(11), "false flags".padStart(12), "broken found".padStart(13), "conf ok/bad".padStart(12), "ms".padStart(5)];
const lines = [hdr.join(" ")];
for (const [k, s] of rows.sort((a, b) => a[0].localeCompare(b[0]))) lines.push([k.padEnd(26), String(s.n).padStart(4), pct(s.exact, s.n).padStart(7), pct(s.within1, s.n).padStart(7), pct(s.inRange, s.n).padStart(9), (s.absErr / s.n).toFixed(2).padStart(6), pct(s.oddHit, s.oddN).padStart(11), String(s.falseFlag).padStart(12), pct(s.brokenHit, s.brokenN).padStart(13), ((s.exact ? s.confExact / s.exact : 0).toFixed(2) + "/" + (s.nWrong ? s.confWrong / s.nWrong : 0).toFixed(2)).padStart(12), String(Math.round(s.ms / s.n)).padStart(5)].join(" "));
console.log(lines.join("\n"));
fs.writeFileSync("test/last-results.txt", lines.join("\n") + "\n");
fs.writeFileSync("test/failures.json", JSON.stringify(failures, null, 1));
console.log(`\n${failures.length} imperfect cases -> test/failures.json`);
