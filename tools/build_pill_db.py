"""Builds pill-db.js from FDA structured product labels (DailyMed / NLM).

Each label carries the physical description of every tablet/capsule it covers:
SPLCOLOR, SPLSHAPE, SPLSIZE (mm), SPLIMPRINT, SPLSCORE. We pull several labels
per drug (different manufacturers) and keep one row per distinct appearance.

Run:  python -I tools/build_pill_db.py
"""
import json, re, sys, time, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

API = "https://dailymed.nlm.nih.gov/dailymed/services/v2"
NS = {"v": "urn:hl7-org:v3"}

# Top oral solid medications in the US (ClinCalc 2024 ranking, oral tablets/capsules),
# plus the brand names pharmacies still dispense often.
DRUGS = [
    "atorvastatin", "levothyroxine", "metformin", "amlodipine", "lisinopril", "losartan",
    "metoprolol tartrate", "metoprolol succinate", "rosuvastatin", "omeprazole", "gabapentin",
    "sertraline", "escitalopram", "amphetamine", "pantoprazole", "bupropion",
    "hydrochlorothiazide", "fluoxetine", "trazodone", "montelukast", "amoxicillin",
    "tamsulosin", "simvastatin", "furosemide", "meloxicam", "hydrocodone bitartrate and acetaminophen",
    "methylphenidate", "duloxetine", "prednisone", "carvedilol", "famotidine", "ibuprofen",
    "buspirone", "venlafaxine", "tramadol", "potassium chloride", "hydroxyzine", "allopurinol",
    "clopidogrel", "ergocalciferol", "cetirizine", "ondansetron", "cyclobenzaprine",
    "spironolactone", "oxycodone hydrochloride", "oxycodone and acetaminophen", "estradiol",
    "glipizide", "zolpidem", "lamotrigine", "alprazolam", "citalopram", "pregabalin",
    "clonazepam", "azithromycin", "pravastatin", "valsartan", "ezetimibe", "diclofenac",
    "propranolol", "atenolol", "lisdexamfetamine", "doxycycline", "amoxicillin and clavulanate",
    "lisinopril and hydrochlorothiazide", "lorazepam", "celecoxib", "finasteride", "quetiapine",
    "clonidine", "aripiprazole", "cephalexin", "alendronate", "topiramate", "tizanidine",
    "losartan potassium and hydrochlorothiazide", "olmesartan", "amitriptyline", "folic acid",
    "fenofibrate", "paroxetine", "warfarin", "valacyclovir", "methocarbamol", "diltiazem",
    "baclofen", "naproxen", "sumatriptan", "mirtazapine", "levetiracetam", "tadalafil",
    "nifedipine", "hydralazine", "glimepiride", "chlorthalidone", "oxybutynin", "pioglitazone",
    "hydroxychloroquine", "sulfamethoxazole and trimethoprim", "benzonatate", "nitrofurantoin",
    "methylprednisolone", "triamterene and hydrochlorothiazide", "donepezil", "ropinirole",
    "dexmethylphenidate", "atomoxetine", "acetaminophen",
    # brands
    "eliquis", "xarelto", "jardiance", "farxiga", "entresto", "januvia", "lipitor", "synthroid",
    "plavix", "adderall", "xanax", "norco", "percocet", "zoloft", "lexapro", "rybelsus",
]
PER_DRUG = 7


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return r.read()
        except Exception as e:  # network hiccup: back off and retry
            if i == tries - 1:
                print("  fail", url, e, file=sys.stderr)
                return None
            time.sleep(1.5 * (i + 1))


def list_setids(drug):
    q = urllib.parse.urlencode({"drug_name": drug, "pagesize": 60})
    raw = get(f"{API}/spls.json?{q}")
    if not raw:
        return []
    rows = json.loads(raw)["data"]
    picked, seen_labelers = [], set()
    for r in rows:  # prefer distinct manufacturers so we see distinct appearances
        lab = re.search(r"\[(.*)\]\s*$", r["title"])
        lab = lab.group(1) if lab else r["title"]
        if lab in seen_labelers:
            continue
        if not re.search(r"TABLET|CAPSULE", r["title"], re.I):
            continue
        seen_labelers.add(lab)
        picked.append((r["setid"], lab, r["title"]))
        if len(picked) >= PER_DRUG:
            break
    return picked


def chars(prod_el):
    out = {}
    for c in prod_el.findall("v:subjectOf/v:characteristic", NS):
        code = c.find("v:code", NS).get("code")
        val = c.find("v:value", NS)
        if val is None:
            continue
        if code == "SPLCOLOR":
            out.setdefault("color", []).append(val.get("displayName", "").lower())
        elif code == "SPLSHAPE":
            out["shape"] = val.get("displayName", "").lower()
        elif code == "SPLSIZE":
            out["size"] = float(val.get("value") or 0)
        elif code == "SPLIMPRINT":
            out["imprint"] = (val.text or "").strip()
        elif code == "SPLSCORE":
            out["score"] = val.get("value")
    return out


def parse(setid, labeler):
    raw = get(f"{API}/spls/{setid}.xml")
    if not raw:
        return []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []
    rows = []
    for mp in root.iter("{urn:hl7-org:v3}manufacturedProduct"):
        prod = mp.find("v:manufacturedProduct", NS)
        if prod is None:
            prod = mp.find("v:manufacturedMedicine", NS)
        if prod is None:
            continue
        form = prod.find("v:formCode", NS)
        form = form.get("displayName", "") if form is not None else ""
        if not re.search(r"TABLET|CAPSULE", form, re.I):
            continue
        name = (prod.findtext("v:name", default="", namespaces=NS) or "").strip()
        ings = []
        for ai in prod.findall("v:ingredient", NS):
            if ai.get("classCode") not in ("ACTIB", "ACTIM", "ACTIR"):
                continue
            n = ai.find("v:ingredientSubstance/v:name", NS)
            q = ai.find("v:quantity/v:numerator", NS)
            if n is None:
                continue
            amt = f"{q.get('value')} {q.get('unit')}" if q is not None else ""
            ings.append((n.text.strip().title(), amt))
        c = chars(mp)
        if not c.get("imprint") or not c.get("color"):
            continue
        rows.append({
            "name": name.title(), "form": form.lower(),
            "ingredients": [i[0] for i in ings],
            "strength": " / ".join(i[1] for i in ings),
            "color": c["color"], "shape": c.get("shape", ""), "sizeMm": c.get("size", 0),
            "imprint": c["imprint"], "score": c.get("score"), "labeler": labeler.title(),
        })
    return rows


def main(out_path):
    jobs = []
    with ThreadPoolExecutor(6) as ex:
        for drug, picks in zip(DRUGS, ex.map(list_setids, DRUGS)):
            print(f"{drug}: {len(picks)} labels", file=sys.stderr)
            jobs += [(drug, s, lab) for s, lab, _ in picks]
        results = list(ex.map(lambda j: (j[0], parse(j[1], j[2])), jobs))
    db, seen = [], set()
    for drug, rows in results:
        for r in rows:
            key = (r["name"].lower(), r["strength"], r["imprint"].upper(), tuple(r["color"]))
            if key in seen:
                continue
            seen.add(key)
            r["query"] = drug
            db.append(r)
    db.sort(key=lambda r: (r["name"], r["strength"]))
    with open(out_path, "w", encoding="utf8") as f:
        f.write("// Generated by tools/build_pill_db.py from FDA DailyMed structured labels.\n")
        f.write(f"// {len(db)} distinct tablet/capsule appearances. Source: dailymed.nlm.nih.gov\n")
        f.write("export const PILL_DB = ")
        json.dump(db, f, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {len(db)} rows", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "pill-db.js")
