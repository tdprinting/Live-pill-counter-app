"""Builds src/pill-db.js from public US-government sources.

  DailyMed  (NLM)  structured product labels -> appearance (colour, shape, size, imprint) + name/strength/labeler/NDC
  RxNav     (NLM)  RxNorm ingredient ids (rxcui) + brand-name whitelist per ingredient
  openFDA   (FDA)  NDC directory -> brand/generic names + rxcui per product code

Raw downloads are cached under tools/cache/ (git-ignored), so re-runs are fast and polite.
Run:   python -I tools/build_pill_db.py [--out src/pill-db.js] [--per-drug 25] [--limit-drugs N]
See tools/DATA-SOURCES.md for provenance and terms.
"""
import argparse, gzip, hashlib, json, os, re, sys, threading, time, urllib.parse, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drug_lists import GENERICS, BRANDS  # noqa: E402

ROOT = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("PILL_CACHE") or ROOT / "cache")
HTTP_CACHE = CACHE / "http"
DAILYMED = "https://dailymed.nlm.nih.gov/dailymed/services/v2"
RXNAV = "https://rxnav.nlm.nih.gov/REST"
OPENFDA = "https://api.fda.gov/drug/ndc.json"
UA = "pill-counter-db-builder/2.0 (offline pill identifier; public data; polite client)"
NS = {"v": "urn:hl7-org:v3"}
HL7 = "{urn:hl7-org:v3}"

SEM = threading.BoundedSemaphore(6)          # <= 6 concurrent requests overall
FDA_LOCK = threading.Lock()                  # openFDA (no key): keep well below 240 req/min
_fda_last = [0.0]
STATS = Counter()

REPACKAGER_HINTS = [
    "repack", "bryant ranch", "a-s medication", "nucare", "proficient rx", "preferred pharmaceuticals", "quality care",
    "direct rx", "directrx", "pd-rx", "rebel distributors", "physicians total care", "lake erie", "st. mary", "medsource",
    "northwind", "henry schein", "asclemed", "enovachem", "unit dose services", "aphena", "denton pharma", "coupler",
    "clinical solutions wholesale", "carilion", "american health packaging", "avkare", "avpak", "golden state",
    "cardinal health", "mckesson", "aidarex", "blenheim", "keltman", "liberty pharmaceuticals", "readymeds", "altura",
    "contract pharmacy", "dispensing solutions", "stat rx", "med-health pharma", "marlex", "legacy pharmaceutical",
    "safecor", "advanced rx", "medvantx", "major pharmaceuticals", "rpk pharmaceuticals", "nostrum", "new horizon rx",
    "lifeline", "quality care products", "pharmasource", "genpak", "mckesson", "walgreens", "cvs", "rite aid", "kroger",
    "walmart", "wal-mart", "target corporation", "meijer", "publix", "h-e-b", "topco", "safeway", "good neighbor",
    "dollar general", "family dollar", "leader", "equate", "up & up", "sunmark", "amerisource", "pharmacy", "apotheca",
]


def http(url, headers=None, tries=5, binary=False, cache=True, fda=False):
    """GET with on-disk cache (gzip), <=6 concurrent, retries with exponential backoff. Returns bytes or None."""
    key = hashlib.sha1(url.encode()).hexdigest()
    path = HTTP_CACHE / key[:2] / (key + ".gz")
    if cache and path.exists():
        try:
            data = gzip.decompress(path.read_bytes())
            STATS["cache_hit"] += 1
            return data
        except (OSError, EOFError):  # being written by another process / truncated: just download again
            pass
    for i in range(tries):
        try:
            if fda:
                with FDA_LOCK:
                    wait = 0.32 - (time.time() - _fda_last[0])
                    if wait > 0:
                        time.sleep(wait)
                    _fda_last[0] = time.time()
            with SEM:
                req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
            STATS["downloaded"] += 1
            if cache:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp%d" % threading.get_ident())
                tmp.write_bytes(gzip.compress(data, 6))
                os.replace(tmp, path)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:  # a definitive "nothing here" (openFDA uses it for zero results)
                if cache:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(gzip.compress(b"", 6))
                return b""
            time.sleep(2 ** (i + 1) + (10 if e.code == 429 else 0))
        except Exception:
            time.sleep(1.5 * (2 ** i))
    STATS["failed"] += 1
    print("  FAILED", url[:140], file=sys.stderr)
    return None


# ---------------------------------------------------------------- names
SALTS = set("""hydrochloride hcl sodium potassium calcium magnesium besylate maleate tartrate succinate bitartrate sulfate
phosphate mesylate fumarate citrate hydrobromide acetate medoxomil anhydrous monohydrate dihydrate hemihydrate trihydrate
bromide chloride nitrate carbonate oxide hydrate disodium dipropionate propionate valerate lactate gluconate pamoate
mononitrate dinitrate saccharate aspartate dihydrochloride cypionate bisulfate hemifumarate tosylate dimesylate
decanoate hyclate monosodium sesquihydrate propanediol propylene glycol solvate cilexetil axetil mofetil etexilate disoproxil alafenamide benzoate stearate xinafoate pivoxil proxetil tromethamine besilate malate oxalate napsylate pidolate orotate edisylate meglumine dimeglumine hydroxide""".split())


def gen_key(name):
    """Salt-stripped lower-case ingredient name (used for matching and for RxNav lookups)."""
    words = re.sub(r"[^a-z0-9 ]", " ", name.lower()).split()
    keep = [w for w in words if w not in SALTS]
    return " ".join(keep or words)


def fix_case(name):
    n = name.strip()
    if n == n.upper() or n == n.lower():
        n = n.title()
        n = re.sub(r"\b(Xl|Xr|Er|Sr|Cr|Hcl|Odt|Dr|La|Sa|Ir|Cd|Hct|Hctz|Lp|Ec|Xt|Ds|Ss|Pm|Am)\b", lambda m: m.group(1).upper(), n)
        n = re.sub(r"\b(And|Of|With|For|The)\b", lambda m: m.group(1).lower(), n)
    return n


def clean_lab(lab):
    t = re.sub(r"\s+", " ", lab.replace("_", " ")).strip().title()
    up = {"llc": "LLC", "lp": "LP", "llp": "LLP", "usa": "USA", "us": "US", "rx": "Rx", "ag": "AG", "hec": "HEC",
          "rpk": "RPK", "ncs": "NCS", "cvs": "CVS", "ii": "II", "iii": "III", "dba": "dba"}
    t = re.sub(r"\b[A-Za-z]+\b", lambda m: up.get(m.group(0).lower(), m.group(0)), t)
    return t


def is_repackager(lab):
    l = lab.lower()
    return any(h in l for h in REPACKAGER_HINTS)


# ---------------------------------------------------------------- DailyMed
def list_labels(query):
    out, page = [], 1
    while page <= 10:
        q = urllib.parse.urlencode({"drug_name": query, "pagesize": 100, "page": page})
        raw = http(f"{DAILYMED}/spls.json?{q}")
        if not raw:
            break
        d = json.loads(raw)
        out += d.get("data", [])
        if page >= int(d.get("metadata", {}).get("total_pages", 1)):
            break
        page += 1
    return out


QSTOP = set("and with of tablets tablet capsule capsules film coated extended release delayed oral usp".split())


def pick_labels(query, labels, per_drug):
    """Choose <= per_drug labels with distinct labelers: pure products first, manufacturers before repackagers."""
    qt = set(re.sub(r"[^a-z0-9 ]", " ", query.lower()).split()) | SALTS | QSTOP
    best = {}
    for r in labels:
        t = r["title"]
        if not re.search(r"TABLET|CAPSULE|CAPLET", t, re.I):
            continue
        m = re.search(r"\[(.*)\]\s*$", t)
        lab = m.group(1).strip() if m else t
        drugpart = re.split(r"\s(?:TABLET|CAPSULE|CAPLET)", t, flags=re.I)[0]
        extra = set(re.sub(r"[^a-z0-9 ]", " ", drugpart.lower()).split()) - qt
        prio = 0 if not extra else 1
        cur = best.get(lab.lower())
        if cur is None or prio < cur[0]:
            best[lab.lower()] = (prio, is_repackager(lab), lab, r["setid"], t)
    cands = sorted(best.values(), key=lambda x: (x[0], x[1], x[2].lower()))
    mfr = [c for c in cands if not c[1]]
    rep = [c for c in cands if c[1]]
    n_rep = min(len(rep), max(6, per_drug - len(mfr)) if len(mfr) < per_drug else 8)
    chosen = mfr[: per_drug - min(n_rep, per_drug)] + rep[:n_rep]
    if len(chosen) < per_drug:
        chosen += [c for c in cands if c not in chosen][: per_drug - len(chosen)]
    return [(c[3], c[2], c[4]) for c in chosen[:per_drug]]


def chars(el):
    out = {}
    for c in el.findall("v:subjectOf/v:characteristic", NS):
        code = c.find("v:code", NS).get("code")
        val = c.find("v:value", NS)
        if val is None:
            continue
        if code == "SPLCOLOR":
            out.setdefault("color", []).append(val.get("displayName", "").lower())
        elif code == "SPLSHAPE":
            out["shape"] = val.get("displayName", "").lower()
        elif code == "SPLSIZE":
            try:
                v = float(val.get("value") or 0)
                if "in" in (val.get("unit") or "").lower():
                    v *= 25.4
                out["size"] = round(v, 1)
            except ValueError:
                pass
        elif code == "SPLIMPRINT":
            out["imprint"] = re.sub(r"\s+", " ", (val.text or "")).strip()
        elif code == "SPLSCORE":
            out["score"] = val.get("value")
    return out


def parse_spl(setid, labeler):
    raw = http(f"{DAILYMED}/spls/{setid}.xml")
    if not raw:
        return []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []
    rows = []
    for mp in root.iter(HL7 + "manufacturedProduct"):
        prod = mp.find("v:manufacturedProduct", NS)
        if prod is None:
            prod = mp.find("v:manufacturedMedicine", NS)
        if prod is None:
            continue
        form = prod.find("v:formCode", NS)
        form = form.get("displayName", "") if form is not None else ""
        if not re.search(r"TABLET|CAPSULE|CAPLET", form, re.I):
            continue
        code = prod.find("v:code", NS)
        ndc = code.get("code") if code is not None and "6.69" in (code.get("codeSystem") or "") else ""
        name = (prod.findtext("v:name", default="", namespaces=NS) or "").strip()
        ings = []
        for ai in prod.findall("v:ingredient", NS):
            if ai.get("classCode") not in ("ACTIB", "ACTIM", "ACTIR"):
                continue
            n = ai.find("v:ingredientSubstance/v:name", NS)
            q = ai.find("v:quantity/v:numerator", NS)
            if n is None or not n.text:
                continue
            amt = f"{q.get('value')} {q.get('unit')}".replace("[iU]", "IU").replace("[USP'U]", "USP units") if q is not None else ""
            ings.append((n.text.strip().title(), amt))
        c = chars(mp)
        if not c.get("imprint") or not c.get("color") or not ings:
            continue
        rows.append({
            "name": fix_case(name), "form": form.lower(), "ing": [i[0] for i in ings],
            "strength": " / ".join(i[1] for i in ings if i[1]), "color": c["color"], "shape": c.get("shape", ""),
            "size": c.get("size", 0), "imprint": c["imprint"], "score": c.get("score"), "labeler": labeler,
            "ndc": ndc, "setid": setid,
        })
    return rows


def parse_cached(setid, labeler):
    p = CACHE / "parsed" / setid[:2] / (setid + ".json")
    if p.exists():
        return json.loads(p.read_text("utf8"))
    rows = parse_spl(setid, labeler)
    # only cache when the download itself succeeded (empty list can also mean "no pill data")
    if http(f"{DAILYMED}/spls/{setid}.xml") is not None:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rows), "utf8")
    return rows


def clean_row(r):
    """Tidy one parsed product: unique colours, plain shape names, drop multivitamin-style (>5 actives) products."""
    if len(r["ing"]) > 5:
        return None
    cols = []
    for c in r["color"]:
        c = c.strip().lower()
        if c and c not in cols:
            cols.append(c)
    r = dict(r, color=cols)
    r["shape"] = re.sub(r"\s*\(.*?\)", "", r["shape"]).strip().lower()
    return r if cols else None


def fix_units(rows):
    """Tidy strength strings: single spaces, 'ug' -> 'mcg', and a bare unit '1' (sloppy label) becomes 'mg' only when
    another label of the same ingredient states that exact amount in mg; otherwise the unit is left off."""
    known = set()
    for r in rows:
        for i, a in zip(r["ing"], r["strength"].split(" / ")):
            m = re.match(r"^\s*([\d.]+)\s+(\S+)\s*$", a)
            if m and m.group(2) == "mg":
                known.add((gen_key(i), m.group(1)))
    for r in rows:
        parts = [re.sub(r"\s+", " ", a).strip() for a in r["strength"].split(" / ")]
        ings = r["ing"] if len(r["ing"]) == len(parts) else [None] * len(parts)
        out = []
        for i, a in zip(ings, parts):
            m = re.match(r"^([\d.]+) 1$", a)
            if m:
                a = f"{m.group(1)} mg" if i and (gen_key(i), m.group(1)) in known else m.group(1)
            a = re.sub(r" ug$", " mcg", a)
            out.append(a)
        r["strength"] = " / ".join(out)
    return rows


def harvest(queries, per_drug):
    """Returns (rows, report). One thread per drug; HTTP is globally throttled to 6 in flight."""
    done = [0]
    lock = threading.Lock()
    report = {}

    def one(q):
        try:
            labels = list_labels(q)
            picks = pick_labels(q, labels, per_drug)
            rows = []
            for setid, lab, _ in picks:
                for r in parse_cached(setid, lab):
                    r["query"] = q
                    rows.append(r)
            report[q] = {"labels_found": len(labels), "labels_used": len(picks), "rows": len(rows)}
            return rows
        finally:
            with lock:
                done[0] += 1
                if done[0] % 10 == 0:
                    print(f"  harvest {done[0]}/{len(queries)}  {dict(STATS)}", file=sys.stderr, flush=True)

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(one, queries))
    return [r for rs in results for r in rs], report


# ---------------------------------------------------------------- RxNav / openFDA enrichment
def rxnav_json(path):
    raw = http(f"{RXNAV}/{path}")
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def rxnav_enrich(keys):
    """keys: set of generic keys (salt-stripped, possibly 'a + b'). -> {key: {"rxcui": str, "brands": [..]}}"""
    out = {}

    def one(key):
        parts = sorted(key.split("+"))
        names = [" / ".join(p.strip() for p in parts), parts[0].strip()] if len(parts) > 1 else [parts[0].strip()]
        rx = None
        for nm in names[:1]:
            d = rxnav_json("rxcui.json?" + urllib.parse.urlencode({"name": nm, "search": 1}))
            ids = (d.get("idGroup") or {}).get("rxnormId") or []
            if ids:
                rx = ids[0]
        brands = set()
        # brand names for each ingredient (union: used only as a whitelist for brand detection)
        for p in parts:
            d = rxnav_json("rxcui.json?" + urllib.parse.urlencode({"name": p.strip(), "search": 1}))
            ids = (d.get("idGroup") or {}).get("rxnormId") or []
            if not ids:
                continue
            rel = rxnav_json(f"rxcui/{ids[0]}/related.json?tty=BN")
            for g in (rel.get("relatedGroup") or {}).get("conceptGroup") or []:
                for cp in g.get("conceptProperties") or []:
                    brands.add(cp["name"])
        return key, {"rxcui": rx or "", "brands": sorted(brands)}

    with ThreadPoolExecutor(6) as ex:
        for k, v in ex.map(one, sorted(keys)):
            out[k] = v
    return out


def openfda_lookup(codes):
    """product_ndc -> {brand, generic, rxcui:[..], type}. Batched OR queries; unreachable/unknown codes are skipped."""
    out, codes = {}, sorted(set(c for c in codes if c))
    batches = [codes[i:i + 40] for i in range(0, len(codes), 40)]

    def one(batch):
        s = "+OR+".join('product_ndc:"%s"' % c for c in batch)
        raw = http(f"{OPENFDA}?search={s}&limit=100", fda=True)
        if not raw:
            return []
        try:
            return json.loads(raw).get("results", [])
        except ValueError:
            return []

    with ThreadPoolExecutor(2) as ex:
        for res in ex.map(one, batches):
            for r in res:
                rx = (r.get("openfda") or {}).get("rxcui") or []
                out[r["product_ndc"]] = {"brand": r.get("brand_name", ""), "generic": r.get("generic_name", ""),
                                         "rxcui": rx, "type": r.get("product_type", "")}
    return out


# ---------------------------------------------------------------- compile
def norm_imprint(s):
    return "|".join(sorted(re.sub(r"[^A-Z0-9]", "", x.upper()) for x in s.split(";") if x.strip()))


def etype(form):
    return "xr" if re.search(r"release", form or "") else ""


def pair_strength(r):
    """ingredient=amount pairs in a canonical order, so 'A 10 mg / B 325 mg' and 'B 325 mg / A 10 mg' merge."""
    amts = [a.strip().lower() for a in r["strength"].split(" / ")]
    if len(amts) == len(r["ing"]):
        return "+".join(sorted(gen_key(i) + "=" + re.sub(r"\s+", "", a) for i, a in zip(r["ing"], amts)))
    return r["strength"].lower()


def merge(rows):
    groups = defaultdict(list)
    for r in rows:
        ik = "+".join(sorted(gen_key(i) for i in r["ing"]))
        key = (ik, pair_strength(r), norm_imprint(r["imprint"]), tuple(sorted(r["color"])), r["shape"], etype(r["form"]))
        groups[key].append(r)
    merged = []
    for key, rs in groups.items():
        clusters = []  # size +-1 mm
        for r in sorted(rs, key=lambda x: (x["size"] == 0, x["size"])):
            for c in clusters:
                if r["size"] == 0 or c[0]["size"] == 0 or abs(r["size"] - c[0]["size"]) <= 1.0:
                    c.append(r)
                    break
            else:
                clusters.append([r])
        for c in clusters:
            merged.append(c)
    return merged


def compile_db(rows, rx, ndcinfo):
    S, Sidx = [""], {"": 0}
    L, Lidx = [], {}
    C, Cidx = [], {}
    H, Hidx = [], {}

    def s(x):
        x = x or ""
        if x not in Sidx:
            Sidx[x] = len(S)
            S.append(x)
        return Sidx[x]

    out = []
    for cl in sorted(merge(rows), key=lambda c: (c[0]["ing"], c[0]["strength"], c[0]["imprint"])):
        r0 = cl[0]
        # display fields from the most common spelling
        name = Counter(x["name"] for x in cl).most_common(1)[0][0]
        generic = Counter(re.sub(r"\s+(Trihydrate|Monohydrate|Dihydrate|Anhydrous|Hemihydrate)$", "", " / ".join(x["ing"]), flags=re.I) for x in cl).most_common(1)[0][0]
        ik = "+".join(sorted(gen_key(i) for i in r0["ing"]))
        rinfo = rx.get(ik, {"rxcui": "", "brands": []})
        wl = {b.lower() for b in rinfo["brands"]}
        brand = ""
        for x in cl:  # a product name that RxNav lists as a brand of this ingredient
            if x["name"].lower() in wl:
                brand = x["name"]
                break
        if not brand:  # openFDA NDC directory confirms a prescription brand RxNav does not list (new / renamed brands)
            for x in cl:
                nf = ndcinfo.get(x["ndc"])
                if (nf and nf["type"] == "HUMAN PRESCRIPTION DRUG" and nf["brand"] and nf["brand"].lower() == x["name"].lower()
                        and gen_key(nf["brand"]) not in {gen_key(i) for i in x["ing"]} and nf["brand"].lower() != nf["generic"].lower()):
                    brand = x["name"]
                    break
        size = max((x["size"] for x in cl if x["size"]), default=0)
        size = round(sum(x["size"] for x in cl if x["size"]) / max(1, sum(1 for x in cl if x["size"])), 1) if size else 0
        labs = []
        for x in sorted(cl, key=lambda x: (is_repackager(x["labeler"]), x["labeler"])):
            lab = clean_lab(x["labeler"])
            if lab not in Lidx:
                Lidx[lab] = len(L)
                L.append(lab)
            if Lidx[lab] not in labs:
                labs.append(Lidx[lab])
        colors = r0["color"]
        ckey = ",".join(colors)
        if ckey not in Cidx:
            Cidx[ckey] = len(C)
            C.append(colors)
        sh = r0["shape"]
        if sh not in Hidx:
            Hidx[sh] = len(H)
            H.append(sh)
        rxc = rinfo["rxcui"]
        out.append([
            s(name), s(generic), s(r0["strength"]), r0["imprint"], Cidx[ckey], Hidx[sh], int(round(size * 10)),
            labs[:6], s(brand), r0["ndc"], rxc, s(r0["form"]), len(cl),
        ])
    return {
        "v": 2, "built": time.strftime("%Y-%m-%d"),
        "cols": ["name", "generic", "strength", "imprint", "color", "shape", "size10", "labelers", "brand", "ndc", "rxcui", "form", "n"],
        "S": S, "L": L, "C": C, "H": H, "R": out,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT.parent / "src" / "pill-db.js"))
    ap.add_argument("--per-drug", type=int, default=25)
    ap.add_argument("--limit-drugs", type=int, default=0)
    ap.add_argument("--no-enrich", action="store_true")
    a = ap.parse_args()
    queries = list(dict.fromkeys(GENERICS + BRANDS))
    if a.limit_drugs:
        queries = queries[: a.limit_drugs]
    print(f"{len(queries)} queries", file=sys.stderr)
    rows, report = harvest(queries, a.per_drug)
    print(f"harvested {len(rows)} raw product rows {dict(STATS)}", file=sys.stderr)
    (CACHE / "harvest-report.json").write_text(json.dumps(report, indent=1), "utf8")
    # keep one copy per (setid, ndc, imprint): the same label can be reached from several queries
    seen, uniq = set(), []
    for r in rows:
        k = (r["setid"], r["ndc"], r["imprint"], r["strength"], tuple(r["color"]), r["name"])
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    rows = fix_units([r for r in (clean_row(r) for r in uniq) if r])
    print(f"{len(rows)} after label-level dedupe and cleaning", file=sys.stderr)
    keys = {"+".join(sorted(gen_key(i) for i in r["ing"])) for r in rows}
    rx, nfo = {}, {}
    if not a.no_enrich:
        print(f"RxNav: {len(keys)} ingredient groups", file=sys.stderr)
        rx = rxnav_enrich(keys)
        codes = {r["ndc"] for r in rows if r["ndc"]}
        print(f"openFDA: {len(codes)} product codes", file=sys.stderr)
        nfo = openfda_lookup(codes)
        print(f"openFDA matched {len(nfo)}", file=sys.stderr)
    db = compile_db(rows, rx, nfo)
    with open(a.out, "w", encoding="utf8") as f:
        f.write("// Generated by tools/build_pill_db.py - DailyMed SPL appearance data + RxNav/openFDA names. Do not edit.\n")
        f.write(f"// {len(db['R'])} distinct tablet/capsule appearances, {len(set(r[1] for r in db['R']))} generic-name spellings. Built {db['built']}.\n")
        f.write("// Row = [name, generic, strength, imprint, color, shape, size*10, labelers[], brand, ndc, rxcui, form, n]; ints index S/C/H/L.\n")
        f.write("export const PILL_DB = ")
        json.dump(db, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    (CACHE / "build-summary.json").write_text(json.dumps({
        "raw_rows": len(rows), "rows": len(db["R"]), "drugs_queried": len(queries), "stats": dict(STATS),
        "rx_groups": len(rx), "rx_with_cui": sum(1 for v in rx.values() if v["rxcui"]),
        "openfda_matched": len(nfo), "bytes": os.path.getsize(a.out)}, indent=1), "utf8")
    print("wrote", a.out, os.path.getsize(a.out), "bytes,", len(db["R"]), "rows", file=sys.stderr)


if __name__ == "__main__":
    main()
