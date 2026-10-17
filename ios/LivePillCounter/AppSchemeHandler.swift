import Foundation
import WebKit

/// Serves the bundled web app (the `app` folder) and the latest camera frames over pillapp://
///   pillapp://app/index.html        -> file from the bundled app folder
///   pillapp://app/__frame/<key>.bin -> binary camera frame (see src/native-bridge.js)
/// Everything is answered synchronously on the calling (main) thread, so a stopped task is never touched.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let store: FrameStore
    private let root: URL?

    init(store: FrameStore) {
        self.store = store
        self.root = Bundle.main.resourceURL?.appendingPathComponent("app", isDirectory: true)
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        if path.hasPrefix("/__frame/") {
            var key = (path as NSString).lastPathComponent
            if key.hasSuffix(".bin") { key = String(key.dropLast(4)) }
            if let data = store.get(key) {
                respond(urlSchemeTask, url: url, status: 200, mime: "application/octet-stream", body: data)
            } else {
                respond(urlSchemeTask, url: url, status: 404, mime: "text/plain", body: Data())
            }
            return
        }

        guard let root = root, !path.contains("..") else {
            respond(urlSchemeTask, url: url, status: 404, mime: "text/plain", body: Data())
            return
        }
        let relative = String(path.dropFirst())
        let fileURL = root.appendingPathComponent(relative)
        if let data = try? Data(contentsOf: fileURL) {
            respond(urlSchemeTask, url: url, status: 200, mime: mimeType(for: fileURL.pathExtension), body: data)
        } else {
            respond(urlSchemeTask, url: url, status: 404, mime: "text/plain", body: Data())
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, body: Data) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        case "css": return "text/css; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
