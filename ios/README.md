# Pill Count: native iPhone app (LiDAR)

A thin Swift shell around the same web app the repo already builds.

```
build_app.py  ->  app/ (index.html, app.js, worker.js, pillcv.js, pill-id.js, pill-db.js, native-bridge.js, icons)
                    |  copied into the app bundle (folder reference in project.yml)
ios/LivePillCounter (Swift)  ->  WKWebView loads pillapp://app/index.html
                              ->  ARKit camera streams RGB + LiDAR depth into the page
```

* `project.yml` is an XcodeGen spec. No `.xcodeproj` is stored; CI runs `xcodegen generate`.
* `PillCountApp.swift` SwiftUI entry, full screen web view.
* `WebContainer.swift` creates the WKWebView, registers the `pillapp` scheme and the `native` message handler.
* `AppSchemeHandler.swift` serves the bundled `app/` files (so ES modules and module Workers load) and the frame blobs at `pillapp://app/__frame/<key>.bin`.
* `DepthCamera.swift` ARSession (sceneDepth + smoothedSceneDepth), converts frames to RGBA (long side 720), sends a frame only after JS acknowledges the previous one, torch, high-res capture (1920).
* `../src/native-bridge.js` the JS side of the contract (frame shape documented at the top of that file).

Build locally (needs a Mac): `python3 build_app.py && cd ios && xcodegen generate`, open `LivePillCounter.xcodeproj`.
Icon: `python tools/make_ios_icon.py` (already generated; rerun only if the icon changes).
CI: `.github/workflows/ios.yml` (simulator build every push; TestFlight upload when the 4 secrets exist).
Step-by-step Apple setup: `HOW TO INSTALL THE LIDAR APP.txt` in the repo root.

The web app is unchanged and keeps working in Safari; `nbAvailable()` is false there.
