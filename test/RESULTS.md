# Accuracy testing

These numbers come from **synthetic** test photos, not real pills. `test/synth.mjs` renders shaded tablets and capsules on trays. The renders include bevels, cast shadows, highlights, uneven light, colour casts, sensor noise and blur. The truth is known exactly. Real photos will behave differently. Use `test/photo-eval.html` to measure the app on your own photos (see `test/photos/README.txt`).

Run it yourself: `node test/run.mjs quick` (exact "Capture" mode) or `node test/run.mjs quick fast` (live preview mode). It takes about 10 minutes and writes `test/last-results.txt`.

The test matrix is 8 pill types × 5 surfaces × 8 lighting setups × 4 layouts. `quick` runs a random 30% of it, 371 photos. Each photo has 12–41 pills. Half of the photos include one different pill, and some include broken halves.

- **Surfaces:** blue tray, black tray, grey tray, beige counter, white plate.
- **Lighting:** even, dim, very dim (noisy), side light, warm bulb, cool light, harsh shadows, overhead lamp glare.
- **Layouts:**
  - spread out
  - touching
  - overlapping (each pill at least 55% visible)
  - piled (pills can be 75% hidden)

## Results (Capture mode, Oct 17 2026)

| Layout | Exact count | Within ±1 | True count inside the shown range |
| --- | --- | --- | --- |
| Spread out | 80% | 90% | 84% |
| Touching | 39% | 64% | 68% |
| Overlapping | 22% | 41% | 75% |
| Piled | 0% | 2% | 19% |

What these mean:

- **Spread-out pills are the reliable case.** Most misses there are white pills on a white plate. The app flags that case ("white-on-white") and asks for a darker tray.
- **Per clump, the engine is right about 2 times in 3, but a photo has many clumps.** Touching and overlapping pills are split by fitting the learned shape of one pill into each clump. With about 10 clumps in a photo, one mistake somewhere is likely. That is why the app shows a range and a confidence bar, and asks you to spread the pills when it sees clumps.
- **Piles can't be counted from one photo.** Hidden pills are invisible to any camera. The app warns "Pills are piled up — spread them out", widens the range, and gives the confidence as 0.
- **Different pills:** 46% of the planted odd pills are caught overall. Colour differences are caught well: blue/green 77%, pink/orange 79%, yellow/white 73%. Same-colour, different-shape pills are harder: white oblong vs white oval 17%, yellow capsule vs yellow oval 16%.
- **Broken pieces:** 70% are found overall. Round and oval tablets do best.
- **Confidence is meaningful.** Exact answers average 0.93 confidence. Wrong ones average 0.72.

Live mode runs the same full engine on every frame at 720 px. When frames take too long it falls back to the faster estimator, then retries the full engine. It shows the count most recent frames agree on. JPEG and video compression were a real-world failure found with `test/photo-eval.html` and are now handled: one sample went from 1151 to 21 pills, with 20 true.

## How to get the most accurate count

1. Use a dark or blue tray. Coloured pills also work on a white plate.
2. Spread the pills so they don't touch. A quick sweep with a spatula is enough.
3. Avoid glare from a lamp directly overhead, or tilt the tray.
4. Use **Capture** for the final number. It runs the slower, more exact analysis on several frames and checks they agree. Then glance at the markers, and tap to add or remove any that are wrong.
5. Use **Recount** for a second, independent check on controlled counts.
