import { identify, searchImprint, searchName, describeGroup, pidDbInfo, pidEntries } from "../src/pill-id.js";
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const G = (o) => ({ count: 1, role: "pill", rgb: [200, 200, 200], halvesRgb: null, twoTone: false, aspect: null, lengthPx: null, lengthMm: null, ...o });
const table = (title, g, opts) => {
  const r = identify(g, opts);
  console.log(`\n== ${title}: ${describeGroup(g)}${opts && opts.imprint ? ` [imprint ${opts.imprint}]` : ""}`);
  for (const x of r) console.log("   ", [x.name, x.strength, x.imprint, x.colors.join("/"), x.shape, x.sizeMm, x.score, x.reasons.join("; ")].join(" | "));
  return r;
};
const ROW_KEYS = ["name", "generic", "strength", "imprint", "colors", "shape", "sizeMm", "labeler", "score", "reasons"];

// ---------- database facts (verified against the generated pill-db.js) ----------
const info = pidDbInfo();
console.log("DB:", JSON.stringify(info));
ok(info.rows >= 8000 && info.drugs >= 500, `database is large (${info.rows} appearances, ${info.drugs} drugs)`);
ok(info.labelers >= 500, `many labelers (${info.labelers})`);

// ---------- appearance ----------
const white = table("white round", G({ colors: ["white"], shape: "round", aspect: 1.02 }));
ok(white.length === 8 && new Set(white.map((x) => x.generic)).size >= 4, "white round: 8 candidates with variety");
ok(white.every((x) => x.score <= 0.6), "appearance-only score <= 0.6");
ok(white.every((x) => ROW_KEYS.every((k) => k in x)), "result rows keep the documented shape");
ok(new Set(white.map((x) => x.generic + "|" + x.strength)).size === white.length, "one row per drug+strength (no duplicates in a shortlist)");
ok(white.every((x) => Array.isArray(x.alsoKnownAs)), "optional alsoKnownAs is always an array");

const pink = table("pink oval 10mm", G({ colors: ["pink"], shape: "oval", aspect: 1.5, lengthMm: 10 }), { limit: 10 });
ok(pink.some((x) => x.name === "Eliquis" && x.strength === "5 mg" && x.imprint === "894 · 5"), "Eliquis 5 mg in top 10 for pink oval 10 mm");

const rw = table("red/white capsule", G({ colors: ["red", "white"], twoTone: true, shape: "capsule", aspect: 2.4 }));
ok(rw.slice(0, 5).every((x) => x.shape === "capsule"), "red/white capsule: top 5 all capsules");
const wr = identify(G({ colors: ["white", "red"], twoTone: true, shape: "capsule", aspect: 2.4 }));
ok(wr[0].name === rw[0].name, "colour order independent");

// a lookalike colour confusion must not hide the drug: white tablets sometimes read as gray
const eli = identify(G({ colors: ["pink"], shape: "oval", aspect: 1.5, lengthMm: 10 }), { limit: 25 });
const eliR = identify(G({ colors: ["red"], shape: "oval", aspect: 1.5, lengthMm: 10 }), { limit: 40 });
ok(eli.length > 0 && eliR.some((x) => x.name === "Eliquis" && x.strength === "5 mg"), "pink read as red still lists Eliquis 5 mg within 40");

// ---------- imprint ----------
const hc = table("M367", G({ colors: ["white"], shape: "oval", aspect: 1.5 }), { imprint: "M367" });
ok(/Hydrocodone/.test(hc[0].generic) && /Acetaminophen/.test(hc[0].generic), "M367 -> hydrocodone/APAP first");
ok(hc[0].strength === "10 mg / 325 mg" && hc[0].score >= 0.9, "M367 strength 10/325, score >= .9");
for (const q of ["m 367", "M3G7", "m-367", "M36 7", "MB67"]) {
  const r = searchImprint(q);
  ok(r.length && /Hydrocodone/.test(r[0].generic) && r[0].strength === "10 mg / 325 mg", `searchImprint("${q}") finds hydrocodone/APAP 10/325 first`);
}

const yq = table("yellow diamond + imprint", G({ colors: ["yellow"], shape: "four-sided", aspect: 1.1 }), { imprint: "1428 10" });
ok(yq[0].name === "Farxiga" && yq[0].strength === "10 mg" && yq[0].score >= 0.9, "1428 10 -> Farxiga 10 mg first");
ok(searchImprint("10 1428")[0].name === "Farxiga", "side order independent");
ok(searchImprint("1428 1O")[0].name === "Farxiga", "O/0 confusion tolerated");

const lip = searchImprint("PD 156");
ok(lip[0].name === "Lipitor" && lip[0].strength === "20 mg", "imprint PD 156 -> Lipitor 20 mg");
const typo = identify(G({ colors: ["white"], shape: "oval", aspect: 1.5 }), { imprint: "PD 1S6", limit: 5 });
ok(typo.slice(0, 3).some((x) => x.name === "Lipitor" && x.strength === "20 mg"), "one wrong character (PD 1S6) still lists Lipitor 20 mg in top 3");

// ---------- name / brand search ----------
const nl = searchName("Lipitor");
ok(nl.length >= 4 && nl.every((x) => x.name === "Lipitor" && /Atorvastatin/.test(x.generic)), "searchName(Lipitor) -> Lipitor rows, generic atorvastatin");
ok(["10 mg", "20 mg", "40 mg", "80 mg"].every((s) => nl.some((x) => x.strength === s)), "Lipitor 10/20/40/80 mg all present");
ok(nl.every((x) => ROW_KEYS.every((k) => k in x)), "searchName rows have the standard shape");
const na = searchName("atorvastatin", { limit: 12 });
ok(na.slice(0, 6).every((x) => /Atorvastatin/.test(x.generic)), "searchName(atorvastatin) -> atorvastatin products first");
ok(na.some((x) => x.alsoKnownAs.includes("Lipitor")), "generic atorvastatin rows list Lipitor as brand alias");
ok(!/\//.test(na[0].generic), "single-ingredient atorvastatin ranks before amlodipine/atorvastatin combinations");
const n20 = searchName("atorvastatin 20");
ok(n20[0].strength === "20 mg" && !/\//.test(n20[0].generic), "searchName(atorvastatin 20) -> 20 mg first");
ok(searchName("lipitr")[0].name === "Lipitor", "fuzzy brand: lipitr -> Lipitor");
ok(/Atorvastatin/.test(searchName("atorvastatn 40mg")[0].generic) && searchName("atorvastatn 40mg")[0].strength === "40 mg", "fuzzy generic + strength: atorvastatn 40mg");
const nx = searchName("xanax");
ok(nx[0].name === "Xanax" && /Alprazolam/.test(nx[0].generic), "searchName(xanax) -> Xanax (alprazolam)");
ok(searchName("alprazolam")[0].alsoKnownAs.includes("Xanax"), "searchName(alprazolam) shows Xanax as brand alias");
ok(searchName("   ").length === 0 && searchName("").length === 0 && searchName("%%").length === 0, "empty / junk name -> no results");
// brand aliasing through the imprint box and through identify
const ib = searchImprint("lipitor");
ok(ib.length >= 4 && ib[0].name === "Lipitor", 'typing "lipitor" in the imprint box finds Lipitor');
const ia = searchImprint("atorvastatin");
ok(ia.length && /Atorvastatin/.test(ia[0].generic), 'typing "atorvastatin" in the imprint box finds atorvastatin');
const idn = table("white oval + name", G({ colors: ["white"], shape: "oval", aspect: 1.5 }), { imprint: "lipitor" });
ok(idn[0].name === "Lipitor" && idn[0].reasons.some((r) => /name/.test(r)), "identify() with a brand name typed ranks Lipitor first");
const idm = identify(G({ colors: ["white"], shape: "oval", aspect: 1.5 }), { imprint: "M367" });
ok(!idm.some((x) => x.reasons.includes("name matches")), "an imprint is not mistaken for a name");

// ---------- options ----------
const all = pidEntries();
const target = all.findIndex((e) => e.name === "Eliquis" && e.strength === "5 mg");
const skipped = identify(G({ colors: ["pink"], shape: "oval", aspect: 1.5, lengthMm: 10 }), { limit: 10, skip: new Set(all.map((e, i) => (e.name === "Eliquis" ? i : -1)).filter((i) => i >= 0)) });
ok(target >= 0 && !skipped.some((x) => x.name === "Eliquis"), "skip option removes rows (used by the hold-out evaluation)");
table("blue round 8mm", G({ colors: ["blue"], shape: "round", aspect: 1.0, lengthMm: 8 }));
ok(describeGroup(G({ colors: ["white"], shape: "round", lengthMm: 8 })) === "white round tablet, ~8 mm", "describeGroup tablet");
ok(describeGroup(G({ colors: ["red", "white"], shape: "capsule" })) === "red/white capsule", "describeGroup capsule");
ok(identify(G({ colors: ["white"], shape: "round" }), { limit: 3 }).length === 3, "limit respected");
ok(identify(G({}), { limit: 5 }).every((x) => x.score <= 0.6), "no colour/shape at all: still capped, no crash");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
