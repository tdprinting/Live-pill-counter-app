# Live Pill Counter

A phone web app that counts pills from the camera, flags odd-looking pills, and suggests what a pill might be by
looking at its colour, shape and markings. It runs entirely on the phone (nothing is uploaded) and is built for iPhone.

## Use it on iPhone / iPad

Open **https://tdprinting.github.io/Live-pill-counter-app/** in **Safari**, tap **Share -> Add to Home Screen**, and it runs
full screen like an app (and keeps working without a signal after the first open). Allow the camera when asked.
Every push to `main` rebuilds it automatically and publishes a new
[Release](https://github.com/tdprinting/Live-pill-counter-app/releases/latest) with a one-file copy you can AirDrop.

Tips: use a dark or blue tray, spread the pills out, avoid glare. Full steps are in `HOW TO PUT IT ON AN IPHONE.txt`.

## How publishing works (plain version)

You never upload files by hand. When you push your changes to the `main` branch on GitHub, a robot (GitHub Actions,
set up in `.github/workflows/iphone.yml`) does this for you:

1. Checks the code has no typing mistakes.
2. Runs `build_app.py`, which makes the `app/` folder and the one-file copy.
3. Publishes `app/` as the website (GitHub Pages).
4. Creates a Release with the downloads.

To build on your own computer instead: `python build_app.py` (needs Python 3, nothing else to install).

## Files

| File | What it is |
| --- | --- |
| `src/index.html` | The app's page. |
| `src/app.js` | The app's screens and camera handling. |
| `src/worker.js` | Runs the heavy image work in the background so the screen stays smooth. |
| `src/pillcv.js` | The pill finding and counting engine. |
| `src/pill-id.js`, `src/pill-db.js` | Pill identification and its pill database. |
| `assets/` | The icon (`icon.svg` and the PNG sizes). |
| `tools/make_icons.py` | Redraws the icon files in `assets/`. |
| `build_app.py` | Builds `app/` (the installable web app) and `Live Pill Counter (standalone).html` (one file to email or AirDrop). The top of this file lists the rules `app.js` and `worker.js` must follow so the one-file copy works. |
| `.github/workflows/iphone.yml` | The automatic build and publish on every push to `main`. |
| `test/` | Accuracy tests for the engine. |
| `app/`, `Live Pill Counter (standalone).html` | Build results. Safe to delete; they are remade by the build. |

## Accuracy testing

Test results are in `test/RESULTS.md`.
