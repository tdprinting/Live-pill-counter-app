import SwiftUI
import UIKit
import WebKit

/// Owns the web view, the camera and the custom URL scheme handler (one of each for the whole app).
final class WebHost: NSObject, WKScriptMessageHandler {
    static let shared = WebHost()

    let store = FrameStore()
    let camera: DepthCamera
    let webView: WKWebView

    private override init() {
        camera = DepthCamera(store: store)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(AppSchemeHandler(store: store), forURLScheme: "pillapp")

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        config.userContentController.add(self, name: "native")

        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        camera.webView = webView

        if let url = URL(string: "pillapp://app/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "start":
            camera.start()
        case "stop":
            camera.stop()
        case "ack":
            camera.ack()
        case "torch":
            camera.setTorch((body["on"] as? Bool) ?? false)
        case "capture":
            let id = (body["id"] as? Int) ?? Int((body["id"] as? Double) ?? 0)
            camera.capture(id: id)
        default:
            break
        }
    }
}

struct WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        return WebHost.shared.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
