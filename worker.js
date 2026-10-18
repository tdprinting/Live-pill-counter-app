// Analysis worker. Receives {id, rgba:ArrayBuffer|ImageData|bitmap:ImageBitmap, width, height, opts}
// and answers {id, result} or {id, error, code}.
import { analyze } from "./pillcv.js";

const KEEP = ["width", "height", "total", "range", "confidence", "pills", "fragments", "blobs", "groups", "background", "warnings", "tray", "depth", "ms"];

function slim(r) {
  const o = {};
  for (const k of KEEP) if (r[k] !== undefined) o[k] = r[k];
  // Any typed array / mask left in nested objects would be heavy: drop them.
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return undefined;
      const c = {};
      for (const k in v) { const s = strip(v[k]); if (s !== undefined) c[k] = s; }
      return c;
    }
    return v;
  };
  return strip(o);
}

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    let data, w = m.width, h = m.height;
    if (m.bitmap) {
      w = m.bitmap.width; h = m.bitmap.height;
      let oc;
      try { oc = new OffscreenCanvas(w, h); } catch (err) { self.postMessage({ id: m.id, error: "no-offscreen", code: "bitmap" }); return; }
      const ctx = oc.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(m.bitmap, 0, 0);
      data = ctx.getImageData(0, 0, w, h).data;
      m.bitmap.close && m.bitmap.close();
    } else if (m.rgba instanceof ImageData) {
      data = m.rgba.data; w = m.rgba.width; h = m.rgba.height;
    } else {
      data = new Uint8ClampedArray(m.rgba);
    }
    const r = analyze(data, w, h, m.opts || {});
    if (r.width == null) r.width = w;
    if (r.height == null) r.height = h;
    self.postMessage({ id: m.id, result: slim(r) });
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err), code: "analyze" });
  }
};
self.postMessage({ ready: true });
