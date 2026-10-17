"""Rebuild the iPhone web app (app/) and the one-file standalone copy from src/.

Run:  python build_app.py                 (local build, version "dev")
      python build_app.py 1.0.20261017.5  (what GitHub Actions runs)

Python 3, standard library only.

STANDALONE BUNDLING CONTRACT (for whoever edits src/app.js and src/worker.js)
---------------------------------------------------------------------------
The standalone file has no other files next to it, so ES-module imports and a separate worker.js
cannot work. The build therefore rewrites the code like this; keep to these rules:

 1. Imports must be single-line statements of the form   import { a, b } from "./x.js";
    (or  import "./x.js";  or  import X from "./x.js").  No `import * as`, no `import { a as b }`,
    no dynamic import(), no import.meta. app.js may import only pill-db.js, pillcv.js, pill-id.js;
    worker.js may import only ./pillcv.js.
 2. Exports: only `export function/const/let/var/class/async function`. `export default` is NOT allowed.
    `export { ... };` lists are simply deleted. The build deletes the word `export`.
 3. All modules are concatenated into ONE scope in this order: pill-db -> pillcv -> pill-id -> native-bridge -> app.
    So top-level function/const/let/var/class names must be unique across those files (the build FAILS
    LOUDLY if two modules declare the same top-level name; same check for pillcv + worker).
    Only declarations starting at column 0 count as "top level", so keep helper code inside functions
    indented and top-level declarations unindented.
 4. The worker must be created EXACTLY as:   new Worker("worker.js", {type:"module"})
    (spacing and quote style are flexible). In the standalone file that expression is replaced with
        new Worker(URL.createObjectURL(new Blob([window.__PILL_WORKER_SRC__], {type:"text/javascript"})))
    where __PILL_WORKER_SRC__ = pillcv.js + worker.js concatenated, imports/exports stripped, run as a
    CLASSIC worker (no import statements, no top-level await in worker.js or pillcv.js).
    Message passing (postMessage / onmessage) is unchanged. Anything the worker needs must come from
    pillcv.js or from postMessage data, since the worker does not see app.js, pill-id.js or pill-db.js.
 5. app.js runs as an inline <script type="module"> in the standalone file (strict mode, deferred).
"""
import base64
import fnmatch
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
ASSETS = os.path.join(HERE, "assets")
APP = os.path.join(HERE, "app")
STANDALONE = os.path.join(HERE, "Live Pill Counter (standalone).html")

version = sys.argv[1] if len(sys.argv) > 1 else "dev"
CACHE_PREFIX = "pill-count-"
EXCLUDE = ["dev-*", "*.test.*"]
ICON_FILES = ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon.svg"]
BUNDLE_ORDER = ["pill-db.js", "pillcv.js", "pill-id.js", "native-bridge.js", "app.js"]
WORKER_ORDER = ["pillcv.js", "worker.js"]
WORKER_CALL = re.compile(r"""new\s+Worker\(\s*(["'])worker\.js\1\s*,\s*\{\s*type\s*:\s*(["'])module\2\s*\}\s*\)""")


def fail(msg):
    sys.exit("BUILD FAILED: " + msg)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def excluded(name):
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE)


# ---------- bundler helpers ----------
IMPORT_RE = re.compile(r"""^[ \t]*import\b(?:[^;"']*?\bfrom\s*)?\s*(["'])\./[\w.\-]+\1\s*;?[ \t]*$""", re.M)
EXPORT_LIST_RE = re.compile(r"""^[ \t]*export\s*\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?\s*;?[ \t]*$""", re.M)
DECL_RE = re.compile(r"^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)", re.M)


def strip_module(name, text):
    if re.search(r"^[ \t]*import\s*\*", text, re.M) or re.search(r"^[ \t]*import\s*\{[^}]*\bas\b", text, re.M):
        fail(f"{name}: `import * as` / `import {{a as b}}` are not supported by the standalone bundler")
    if re.search(r"\bimport\.meta\b|[^\w.]import\s*\(", text):
        fail(f"{name}: import.meta / dynamic import() are not supported by the standalone bundler")
    if re.search(r"^[ \t]*export\s+default\b", text, re.M):
        fail(f"{name}: `export default` is not supported by the standalone bundler")
    text = EXPORT_LIST_RE.sub("", text)
    text = IMPORT_RE.sub("", text)
    if re.search(r"^[ \t]*import\s+[\w{*]", text, re.M):
        fail(f"{name}: an import statement is written in a form the bundler cannot strip (use one-line imports)")
    return re.sub(r"^([ \t]*)export\s+", r"\1", text, flags=re.M)


def bundle(files):
    parts, seen = [], {}
    for fn in files:
        path = os.path.join(SRC, fn)
        if not os.path.isfile(path):
            fail(f"src/{fn} is missing")
        code = strip_module(fn, read(path))
        for m in DECL_RE.finditer(code):
            nm = m.group(1)
            if nm in seen and seen[nm] != fn:
                fail(f"duplicate top-level name '{nm}' in {seen[nm]} and {fn}: rename one (the standalone bundle shares one scope)")
            seen[nm] = fn
        parts.append(f"// ===== {fn} =====\n{code}\n")
    return "\n".join(parts)


# ---------- 0) sanity ----------
for must in ["index.html", "worker.js"] + BUNDLE_ORDER:
    if not os.path.isfile(os.path.join(SRC, must)):
        fail(f"src/{must} is missing")
for icon in ICON_FILES:
    if not os.path.isfile(os.path.join(ASSETS, icon)):
        fail(f"assets/{icon} is missing (run: python tools/make_icons.py)")

index_src = read(os.path.join(SRC, "index.html"))
index_src = index_src.replace('<span class="app-version"></span>', f'<span class="app-version"> Version {version}.</span>')
if "</head>" not in index_src or "</body>" not in index_src:
    fail("src/index.html needs </head> and </body>")

HEAD_TAGS = [
    ("viewport", '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'),
    ("apple-mobile-web-app-capable", '<meta name="apple-mobile-web-app-capable" content="yes">'),
    ("mobile-web-app-capable", '<meta name="mobile-web-app-capable" content="yes">'),
    ("apple-mobile-web-app-title", '<meta name="apple-mobile-web-app-title" content="Pill Count">'),
    ("apple-mobile-web-app-status-bar-style", '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'),
    ("theme-color", '<meta name="theme-color" content="#0a111c">'),
]


def augment_head(html, icon_links):
    add = [tag for key, tag in HEAD_TAGS if not re.search(r"""name=["']%s["']""" % re.escape(key), html)]
    add.append(icon_links)
    return html.replace("</head>", "\n".join(add) + "\n</head>", 1)


# ---------- 1) installable web app: app/ (published to GitHub Pages) ----------
if os.path.isdir(APP):
    shutil.rmtree(APP)
os.makedirs(APP)
js_files = sorted(f for f in os.listdir(SRC) if f.endswith(".js") and not excluded(f))
for f in js_files:
    shutil.copyfile(os.path.join(SRC, f), os.path.join(APP, f))
for f in ICON_FILES:
    shutil.copyfile(os.path.join(ASSETS, f), os.path.join(APP, f))

app_icons = """<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<link rel="icon" type="image/svg+xml" href="icon.svg">
<link rel="manifest" href="manifest.webmanifest">"""
sw_register = """<script>
  // Offline support: the service worker keeps a copy so the app opens with no signal.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
</script>
"""
page = augment_head(index_src, app_icons).replace("</body>", sw_register + "</body>", 1)
write(os.path.join(APP, "index.html"), page)

manifest = {
    "name": "Live Pill Counter",
    "short_name": "Pill Count",
    "id": "./",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "orientation": "any",
    "background_color": "#0a111c",
    "theme_color": "#0a111c",
    "icons": [
        {"src": "apple-touch-icon.png", "sizes": "180x180", "type": "image/png"},
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"},
    ],
}
write(os.path.join(APP, "manifest.webmanifest"), json.dumps(manifest, indent=2))

core = ["./", "index.html", "manifest.webmanifest"] + ICON_FILES + js_files
SW = """// Pill Count service worker: version __VERSION__
// The page itself is fetched fresh when online (so updates show up right away) and from the cache when offline.
// Everything else (scripts, pill database, icons) is served from the cache first.
const CACHE = "__PREFIX____VERSION__";
const CORE = __CORE__;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("__PREFIX__") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("index.html", copy)); return res; })
        .catch(() => caches.match("index.html"))
    );
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
    })));
  }
});
"""
write(os.path.join(APP, "sw.js"),
      SW.replace("__VERSION__", version).replace("__PREFIX__", CACHE_PREFIX).replace("__CORE__", json.dumps(core)))

# ---------- 2) one-file standalone copy (email / AirDrop) ----------
app_js = bundle(BUNDLE_ORDER)
worker_js = bundle(WORKER_ORDER)
if not WORKER_CALL.search(app_js):
    fail('src/app.js must create the worker exactly as: new Worker("worker.js", {type:"module"})')
app_js = WORKER_CALL.sub(
    'new Worker(URL.createObjectURL(new Blob([window.__PILL_WORKER_SRC__], {type:"text/javascript"})))', app_js)
if re.search(r"^[ \t]*import\s+[\w{*]", worker_js, re.M):
    fail("worker bundle still contains an import statement")


def js_string_literal(s):
    return json.dumps(s).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


for label, code in (("app bundle", app_js), ("worker bundle", worker_js)):
    if "</script" in code.lower():
        fail(f"{label} contains the text '</script' which would end the inline script early")

png = base64.b64encode(open(os.path.join(ASSETS, "apple-touch-icon.png"), "rb").read()).decode()
one_icons = f"""<link rel="apple-touch-icon" href="data:image/png;base64,{png}">
<link rel="icon" type="image/png" href="data:image/png;base64,{png}">"""
one = augment_head(index_src, one_icons)
script_tag = re.compile(r"""<script\b[^>]*\bsrc=["']app\.js["'][^>]*>\s*</script>""")
if not script_tag.search(one):
    fail('src/index.html must contain <script type="module" src="app.js"></script>')
inline = ("<script>window.__PILL_WORKER_SRC__ = " + js_string_literal(worker_js) + ";</script>\n"
          '<script type="module">\n' + app_js + "\n</script>")
one = script_tag.sub(lambda m: inline, one, count=1)
write(STANDALONE, one)

print(f"Built version {version}: app/ ({len(js_files)} scripts, sw.js, manifest, icons) and '{os.path.basename(STANDALONE)}'.")
