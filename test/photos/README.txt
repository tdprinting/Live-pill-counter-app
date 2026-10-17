PILL COUNTER - REAL PHOTO ACCURACY TEST
=======================================

What this is: a way to find out how often the counter is right on REAL photos.

1. TAKE PHOTOS (iPhone camera is fine)
   - Put pills on a tray or plate. Count them yourself, carefully. That is the "truth".
   - Vary things: bright light and dim light, different tray colours (blue, white,
     black, grey, counter top), pills spread out, touching, and a few overlapping.
   - Shoot from straight above, whole tray in the frame, avoid big glare.
   - 20 to 50 photos gives a useful picture.

2. NAME EACH FILE WITH THE TRUE COUNT FIRST
   Format:  COUNT_tag_tag_tag.jpg   (tags optional, separated by underscores)
   Examples:
     30_metformin_bluetray_touching.jpg
     12_white_on_white.jpg
     45_3broken_2odd.jpg
   Special tags (optional, used to check the extra features):
     3broken  = 3 broken pieces are on the tray (do NOT count broken pieces in COUNT)
     2odd     = 2 different pills are mixed in (DO count them in COUNT)
   A file with no number at the start still gets analysed, just with no right/wrong score.
   Put all the files in this folder (test/photos/). iPhone photos may be .jpg or .heic;
   if a .heic will not open in your browser, set the iPhone to Settings > Camera >
   Formats > Most Compatible, or share the photo as JPG.

3. OPEN THE EVALUATION PAGE
   Option A (easiest, no folder needed): open a terminal in the project folder
   (the one that contains "src" and "test") and run:
        python -m http.server 8800
   then open  http://localhost:8800/test/photo-eval.html  in Chrome or Edge,
   and press "Choose photos" (or drag photos onto the page). Pick the files from
   anywhere, e.g. test/photos/.
   Option B (phone): run the same server, find your PC's address on Wi-Fi
   (e.g. 192.168.1.20) and open http://192.168.1.20:8800/test/photo-eval.html in
   iPhone Safari, then "Choose photos" to pick from the camera roll.
   (Opening photo-eval.html by double-click will NOT work; it needs the server.)

   The page shows a summary (exact %, within-1 %, in-range %, average error) for each
   of four runs: full/tray, full/free, fast/tray, fast/free, then a table per photo with
   the circled pills. Press "Download results JSON" and send that file back so the
   engine can be tuned.
   Stop the server with Ctrl+C when finished.

Marker colours: green = counted pill, red = flagged as an odd (different) pill,
amber = low confidence, magenta X = broken piece (not counted).

Sample images in this folder (made by the synthetic generator, not real photos):
   20_1odd_1broken_sample.jpg, 25_touching_sample.jpg, 15_dim_white_sample.jpg
Use them to check the page works; delete them before judging real accuracy.
