import { identify, searchImprint, describeGroup } from "../src/pill-id.js";
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const G = (o) => ({ count: 1, role: "pill", rgb: [200, 200, 200], halvesRgb: null, twoTone: false, aspect: null, lengthPx: null, lengthMm: null, ...o });
const table = (title, g, opts) => {
  const r = identify(g, opts);
  console.log(`\n== ${title}: ${describeGroup(g)}${opts && opts.imprint ? ` [imprint ${opts.imprint}]` : ""}`);
  console.table(r.map((x) => ({ name: x.name, strength: x.strength, imprint: x.imprint, col: x.colors.join("/"), shape: x.shape, mm: x.sizeMm, score: x.score, why: x.reasons.join("; ") })));
  return r;
};

const white = table("white round", G({ colors: ["white"], shape: "round", aspect: 1.02 }));
ok(white.length === 8 && new Set(white.map((x) => x.generic)).size >= 4, "white round: 8 candidates with variety");
ok(white.every((x) => x.score <= 0.6), "appearance-only score <= 0.6");

const pink = table("pink oval 10mm", G({ colors: ["pink"], shape: "oval", aspect: 1.5, lengthMm: 10 }));
ok(pink.some((x) => x.name === "Eliquis" && x.strength === "5 mg" && x.imprint === "894 · 5"), "Eliquis 5 mg in top 8");

const hc = table("M367", G({ colors: ["white"], shape: "oval", aspect: 1.5 }), { imprint: "M367" });
ok(/Hydrocodone/.test(hc[0].generic) && /Acetaminophen/.test(hc[0].generic), "M367 -> hydrocodone/APAP first");
ok(hc[0].strength === "10 mg / 325 mg" && hc[0].score >= 0.9, "M367 strength 10/325, score >= .9");
for (const q of ["m 367", "M3G7", "m-367", "M36 7", "MB67"]) {
  const r = searchImprint(q);
  ok(r.length && /Hydrocodone/.test(r[0].generic) && r[0].strength === "10 mg / 325 mg", `searchImprint("${q}") finds Norco 10/325 first`);
}

const rw = table("red/white capsule", G({ colors: ["red", "white"], twoTone: true, shape: "capsule", aspect: 2.4 }));
ok(rw.slice(0, 5).every((x) => x.shape === "capsule"), "red/white capsule: top 5 all capsules");
const wr = identify(G({ colors: ["white", "red"], twoTone: true, shape: "capsule", aspect: 2.4 }));
ok(wr[0].name === rw[0].name, "colour order independent");

const yq = table("yellow four-sided + imprint", G({ colors: ["yellow"], shape: "four-sided", aspect: 1.1 }), { imprint: "1428 10" });
ok(yq[0].name === "Farxiga" && yq[0].strength === "10 mg" && yq[0].score >= 0.9, "1428 10 -> Farxiga 10 mg first");
ok(searchImprint("10 1428")[0].name === "Farxiga", "side order independent");

table("blue round 8mm", G({ colors: ["blue"], shape: "round", aspect: 1.0, lengthMm: 8 }));
ok(describeGroup(G({ colors: ["white"], shape: "round", lengthMm: 8 })) === "white round tablet, ~8 mm", "describeGroup tablet");
ok(describeGroup(G({ colors: ["red", "white"], shape: "capsule" })) === "red/white capsule", "describeGroup capsule");
ok(identify(G({ colors: ["white"], shape: "round" }), { limit: 3 }).length === 3, "limit respected");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
