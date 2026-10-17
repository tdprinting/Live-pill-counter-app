// Native bridge: lets the web app get camera + LiDAR frames from the iPhone app shell (ios/).
// In a normal browser nbAvailable() is false and nothing here does anything.
//
// FRAME CONTRACT (the object handed to onFrame and resolved by nbCapture):
//   {
//     rgba:   Uint8ClampedArray, width*height*4, RGBA, opaque. SENSOR orientation (landscape, NOT rotated
//             to the phone's orientation). Long side ~720 px for the live stream, ~1920 px for nbCapture.
//     width, height,
//     intrinsics: { fx, fy, cx, cy }   pixels of the rgba image (already scaled to width x height),
//     depth:  null when the phone has no LiDAR, otherwise EXACTLY the engine's opts.depth shape:
//             { data: Float32Array (w*h, METERS, 0 = no reading), w, h,   (256x192 on current iPhones)
//               conf: Uint8Array (w*h; 0 low, 1 medium, 2 high) or null,
//               fx, fy, cx, cy }        same intrinsics as above, in RGBA-image pixel units
//   }
//   Depth has the same orientation and field of view as rgba, just lower resolution.
// Frames are pushed only after the previous one was delivered (so the page never gets a backlog).
//
// Swift side talks to this file through window.__native.* (set below) and receives commands through
// window.webkit.messageHandlers.native.postMessage({cmd: "start" | "ack" | "stop" | "torch" | "capture", ...}).
// Frame bytes are fetched from the app's own custom URL scheme: /__frame/<key>.bin
//   layout: RGBA (w*h*4) | Float32 depth (dw*dh*4) | UInt8 confidence (dw*dh)   (dw = dh = 0 when no depth)
let nbHandler = null;
let nbErrorHandler = null;
let nbCapSeq = 0;
const nbCaptures = new Map();

function nbPost(msg) {
  window.webkit.messageHandlers.native.postMessage(msg);
}

async function nbLoadFrame(key, w, h, dw, dh, fx, fy, cx, cy) {
  const res = await fetch("/__frame/" + key + ".bin", { cache: "no-store" });
  if (!res.ok) throw new Error("frame fetch failed: " + res.status);
  const buf = await res.arrayBuffer();
  const n = w * h * 4;
  const hasDepth = dw > 0 && dh > 0;
  if (buf.byteLength < n + (hasDepth ? dw * dh * 5 : 0)) throw new Error("frame too short");
  return {
    rgba: new Uint8ClampedArray(buf, 0, n),
    width: w,
    height: h,
    intrinsics: { fx, fy, cx, cy },
    depth: hasDepth ? {
      data: new Float32Array(buf, n, dw * dh),
      w: dw,
      h: dh,
      conf: new Uint8Array(buf, n + dw * dh * 4, dw * dh),
      fx, fy, cx, cy,
    } : null,
  };
}

function nbReportError(msg) {
  if (nbErrorHandler) nbErrorHandler(msg);
  else console.warn("[native]", msg);
}

window.__native = {
  // called by Swift for each new live frame
  onFrame(seq, w, h, dw, dh, fx, fy, cx, cy) {
    nbLoadFrame(String(seq), w, h, dw, dh, fx, fy, cx, cy)
      .then((f) => { if (nbHandler) nbHandler(f); })
      .catch((e) => nbReportError(String((e && e.message) || e)))
      .finally(() => nbPost({ cmd: "ack", seq }));
  },
  // called by Swift when a high-res capture is ready
  onCapture(id, w, h, dw, dh, fx, fy, cx, cy) {
    const p = nbCaptures.get(id);
    if (!p) return;
    nbCaptures.delete(id);
    nbLoadFrame("c" + id, w, h, dw, dh, fx, fy, cx, cy).then(p.resolve, p.reject);
  },
  onCaptureError(id, msg) {
    const p = nbCaptures.get(id);
    if (!p) return;
    nbCaptures.delete(id);
    p.reject(new Error(msg));
  },
  onError(msg) { nbReportError(msg); },
};

export function nbAvailable() { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native); }
export function nbStart(onFrame, onError) {
  nbHandler = onFrame;
  nbErrorHandler = onError || null;
  nbPost({ cmd: "start" });
}
export function nbStop() {
  nbHandler = null;
  nbPost({ cmd: "stop" });
}
export function nbTorch(on) { nbPost({ cmd: "torch", on: !!on }); }
export function nbCapture() {
  return new Promise((resolve, reject) => {
    const id = ++nbCapSeq;
    nbCaptures.set(id, { resolve, reject });
    nbPost({ cmd: "capture", id });
  });
}
