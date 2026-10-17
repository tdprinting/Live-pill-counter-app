import ARKit
import AVFoundation
import CoreImage
import Foundation
import WebKit

/// Keeps the few most recent frame blobs so the page can fetch them over pillapp://.
final class FrameStore {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var order: [String] = []

    func put(_ key: String, _ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        items[key] = data
        order.append(key)
        while order.count > 4 {
            let old = order.removeFirst()
            items.removeValue(forKey: old)
        }
    }

    func get(_ key: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return items[key]
    }
}

struct FramePacket {
    let data: Data          // RGBA | Float32 depth | UInt8 confidence
    let width: Int
    let height: Int
    let depthWidth: Int
    let depthHeight: Int
    let fx: Float
    let fy: Float
    let cx: Float
    let cy: Float

    /// "w,h,dw,dh,fx,fy,cx,cy" as JavaScript arguments.
    var jsArgs: String {
        return "\(width),\(height),\(depthWidth),\(depthHeight),\(fx),\(fy),\(cx),\(cy)"
    }
}

/// ARKit camera + LiDAR depth. Frames are produced only after JS acknowledged the previous one.
final class DepthCamera: NSObject, ARSessionDelegate {
    weak var webView: WKWebView?

    private let store: FrameStore
    private let session = ARSession()
    private let queue = DispatchQueue(label: "pillcount.depthcamera")
    private let ciContext = CIContext(options: nil)

    // Only touched on `queue`.
    private var seq = 0
    private var running = false
    private var awaitingAck = false
    private var lastSent = Date.distantPast

    init(store: FrameStore) {
        self.store = store
        super.init()
        session.delegate = self
        session.delegateQueue = queue
    }

    // MARK: commands from JS

    func start() {
        queue.async {
            guard ARWorldTrackingConfiguration.isSupported else {
                self.report("ARKit is not supported on this device")
                return
            }
            let config = ARWorldTrackingConfiguration()
            var semantics: ARConfiguration.FrameSemantics = []
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
                semantics.insert(.sceneDepth)
            }
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
                semantics.insert(.smoothedSceneDepth)
            }
            config.frameSemantics = semantics
            self.awaitingAck = false
            self.running = true
            self.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        }
    }

    func stop() {
        queue.async {
            self.running = false
            self.session.pause()
        }
    }

    func ack() {
        queue.async {
            self.awaitingAck = false
        }
    }

    func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        do {
            try device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        } catch {
            report("Torch failed: \(error.localizedDescription)")
        }
    }

    func capture(id: Int) {
        queue.async {
            guard let frame = self.session.currentFrame,
                  let packet = self.makePacket(frame: frame, longSide: 1920) else {
                self.evalJS("window.__native && window.__native.onCaptureError(\(id), \"No camera frame available\")")
                return
            }
            self.store.put("c\(id)", packet.data)
            self.evalJS("window.__native && window.__native.onCapture(\(id),\(packet.jsArgs))")
        }
    }

    // MARK: ARSessionDelegate (runs on `queue`)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running else { return }
        if awaitingAck {
            // If JS never answers (page reloaded), do not stall forever.
            if Date().timeIntervalSince(lastSent) < 1.0 { return }
            awaitingAck = false
        }
        guard let packet = makePacket(frame: frame, longSide: 720) else { return }
        awaitingAck = true
        lastSent = Date()
        seq += 1
        store.put(String(seq), packet.data)
        evalJS("window.__native && window.__native.onFrame(\(seq),\(packet.jsArgs))")
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        report("AR session failed: \(error.localizedDescription)")
    }

    // MARK: frame conversion

    private func makePacket(frame: ARFrame, longSide: CGFloat) -> FramePacket? {
        let image = CIImage(cvPixelBuffer: frame.capturedImage)
        let srcW = image.extent.width
        let srcH = image.extent.height
        guard srcW > 0, srcH > 0 else { return nil }

        let scale = min(1, longSide / max(srcW, srcH))
        let w = max(1, Int((srcW * scale).rounded()))
        let h = max(1, Int((srcH * scale).rounded()))
        let sx = CGFloat(w) / srcW
        let sy = CGFloat(h) / srcH
        let scaled = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy))

        var all = Data(count: w * h * 4)
        all.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            if let base = raw.baseAddress {
                ciContext.render(scaled,
                                 toBitmap: base,
                                 rowBytes: w * 4,
                                 bounds: CGRect(x: 0, y: 0, width: w, height: h),
                                 format: .RGBA8,
                                 colorSpace: CGColorSpaceCreateDeviceRGB())
            }
        }

        var dw = 0
        var dh = 0
        if let depth = frame.smoothedSceneDepth ?? frame.sceneDepth {
            let dm = depth.depthMap
            dw = CVPixelBufferGetWidth(dm)
            dh = CVPixelBufferGetHeight(dm)
            all.append(copyPlane(dm, bytesPerPixel: 4))
            if let cm = depth.confidenceMap,
               CVPixelBufferGetWidth(cm) == dw, CVPixelBufferGetHeight(cm) == dh {
                all.append(copyPlane(cm, bytesPerPixel: 1))
            } else {
                all.append(Data(count: dw * dh))
            }
        }

        let k = frame.camera.intrinsics
        let res = frame.camera.imageResolution
        let kx = Float(w) / Float(res.width)
        let ky = Float(h) / Float(res.height)
        return FramePacket(data: all, width: w, height: h, depthWidth: dw, depthHeight: dh,
                           fx: k[0][0] * kx, fy: k[1][1] * ky,
                           cx: k[2][0] * kx, cy: k[2][1] * ky)
    }

    /// Copies a pixel buffer into tightly packed bytes (drops row padding).
    private func copyPlane(_ buffer: CVPixelBuffer, bytesPerPixel: Int) -> Data {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else {
            return Data(count: width * height * bytesPerPixel)
        }
        var out = Data(capacity: width * height * bytesPerPixel)
        for row in 0..<height {
            out.append(Data(bytes: base + row * rowBytes, count: width * bytesPerPixel))
        }
        return out
    }

    // MARK: JS helpers

    private func report(_ message: String) {
        let data = (try? JSONEncoder().encode(message)) ?? Data("\"error\"".utf8)
        let literal = String(data: data, encoding: .utf8) ?? "\"error\""
        evalJS("window.__native && window.__native.onError(\(literal))")
    }

    private func evalJS(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
