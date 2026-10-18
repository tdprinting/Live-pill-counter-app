# Identifier results (simulation), 2026-10-18

Plain-language summary of `node test/id-eval.mjs` for the pill identifier in `src/pill-id.js`.

**Read this first.** These numbers come from a computer simulation of the camera and the vision engine. They are NOT real photographs and
NOT a clinical validation. The simulation takes a pill from the database, "looks at it" through an imitation of camera noise (see the list below),
and checks whether the identifier gets it right. The noise rates are my assumptions, not measurements of the real engine. Use the numbers to
compare versions and to see what kind of help each input gives, not as a promise of real-world accuracy. Never use appearance alone to name a medicine.

## What a pharmacist should take from it

| Question | Answer (simulated) |
|---|---|
| Imprint typed correctly: is the right drug + strength the #1 suggestion? | **About 95 to 96 times in 100** (98 in 100 when the camera also measured the size, about 94 when it did not). It is in the top 5 about 99.7 times in 100. |
| Imprint typed with ONE wrong character (misread O/0, a missed letter...)? | #1 about **68 in 100**, in the top 5 about **83 in 100**. Short imprints (2 to 3 characters) are the weak spot. |
| Appearance only (colour + shape + maybe size, no imprint): is the right drug in the top-5 shortlist? | **About 15 in 100 overall**: about 22 in 100 when the size was measured, only about 7 in 100 when it was not. #1 is right about 5 in 100. |
| Same, but this manufacturer's version of the tablet is not in the database? | About 8 in 100 in the top 5 (12 in 100 with a size). |
| Controlled substances specifically (oxycodone, hydrocodone/APAP, alprazolam, ...)? | Appearance-only top 5: about 8 in 100. With the imprint typed: #1 about 96 in 100. No better and no worse than the rest, but they sit inside huge look-alike groups (below). |

Why appearance alone is so weak: the database now has 11,185 tablet/capsule appearances. 209 different drug + strength combinations are
white, round and 8 mm. Colour, shape and size cannot separate them. That is exactly why the app caps the score at 0.6 without an imprint and says
"confirm with the imprint". Measuring the size (calibrating the camera) is worth roughly three times more than anything else we can tune.

## Numbers

Hit = a returned row whose active ingredient(s) and strength match the true pill (any labeler; salts such as "hydrochloride" ignored; immediate vs
extended release is NOT distinguished in this scoring). Each result row is one drug + strength (the best-looking version of it).

Test sample: 3,000 database appearances chosen at random (seed 1337). Also run with a second seed and with "every drug+strength equally likely"
sampling, because drugs with many looks would otherwise count more.

### Before and after

"Old identifier + old DB" is what shipped this morning (1,257 appearances, 148 drugs). "Old identifier + new DB" is the old algorithm run on the new
11,185-row data: this separates "the problem got harder because there are 9x more look-alikes" from "the identifier got better".

| Appearance + ... | Old identifier, old DB (1,257 rows) | Old identifier, new DB | **New identifier, new DB** |
|---|---|---|---|
| appearance only: #1 / top 5 / top 10 | 9.7 / 27.8 / 40.3 % | 3.4 / 10.1 / 14.9 % | **5.1 / 14.9 / 23.2 %** |
| appearance only, this version held out: top 5 | not measurable | not measurable | **8.1 %** (top 10: 12.5 %) |
| correct imprint: #1 / top 5 | 99.0 / 99.9 % | 93.9 / 98.9 % | **95.6 / 99.7 %** |
| imprint with 1 typo: #1 / top 5 | 67.5 / 75.1 % | 58.8 / 68.0 % | **68.4 / 82.8 %** |

Drug+strength-weighted sample (each of the 1,902 drug+strengths once, a random look each; the old DB row uses its own 559 drug+strengths):

| | Old, old DB | Old, new DB | **New, new DB** |
|---|---|---|---|
| appearance only top 5 | 28.8 % | 7.3 % | **15.8 %** |
| correct imprint #1 | 97.9 % | 93.8 % | **94.9 %** |
| imprint with 1 typo #1 / top 5 | 67.1 / 75.3 % | 57.3 / 66.1 % | **66.7 / 81.2 %** |

Reading it: on the same big database the new identifier doubles the appearance-only shortlist hit rate (7.3 to 15.8 %, drug-weighted)
and fixes most typo failures (57 to 67 % at #1; 66 to 81 % in the top 5). The old identifier looked better on its own small database only
because that database had few look-alikes; it was not that the old one was more accurate.

A second random seed gave 15.2 % (appearance top 5), 96.0 % (imprint #1), 68.5 % (typo #1): the results are stable to about one point.

### Stress test: twice as many camera mistakes

Colour and shape confusion rates doubled, shape unknown 20 % of the time, size missing 70 % of the time, size error up to 16 % (2,000 samples):

| | Old identifier, new DB | New identifier, new DB |
|---|---|---|
| appearance only top 5 | 4.5 % | **7.2 %** |
| correct imprint #1 | 91.8 % | **93.8 %** |
| imprint with 1 typo #1 | 53.6 % | **62.7 %** |

### By size and by colour/shape (new identifier, 3,000 samples)

| Input | appearance-only top 5 | correct imprint #1 | 1 typo #1 |
|---|---|---|---|
| size measured (1,524 trials) | 22.4 % | 97.7 % | 73.9 % |
| no size (1,476 trials) | 7.1 % | 93.6 % | 62.8 % |

Appearance-only top 5 by true colour: white 5.6 %, yellow 13.6 %, pink 17.2 %, orange 18.3 %, blue 18.9 %, brown 19.7 %, green 27.3 %,
red 27.7 %, gray 29.4 %, purple 40.9 %. By shape: round 9.4 %, oval 14.4 %, capsule 21.4 %, diamond 50 %, triangle 55 % (those last two are small samples).
White round tablets are the hard class (5.6 %); unusual colours and shapes narrow the field quickly.

## Hardest look-alike groups (same colour + shape + size to the nearest mm)

Number of different drug + strength combinations in the database that look the same:

| Group | Drug+strengths | Controlled substances inside (examples) |
|---|---|---|
| white round 8 mm | 209 | amphetamine sulfate 5/10 mg, buprenorphine 4 mg ... (28 controlled) |
| white round 6 mm | 190 | buprenorphine 2 mg, buprenorphine/naloxone 2/0.5 mg, clonazepam 0.25 mg ... (23) |
| white round 7 mm | 177 | alprazolam 0.25 mg, Adderall (four amphetamine salts, 1.25 mg each), buprenorphine 2 mg ... (23) |
| white round 9 mm | 143 | alprazolam 0.5 mg, Klonopin 2 mg, amphetamine 5 mg ... (14) |
| white round 10 mm | 139 | acetaminophen/codeine 300/15 and 300/30, Percocet ... (14) |
| white round 11 mm | 103 | acetaminophen/codeine 300/15, /30, /60 ... (16) |
| white capsule 14 mm | 75 | hydrocodone/APAP 5/325, dextroamphetamine 5 and 10 mg ... (12) |
| yellow round 8 mm | 75 | clonazepam 0.25, 0.5, 1 mg ... (9) |
| yellow round 6 mm / 7 mm / 9 mm | 71 / 62 / 58 | |
| white oval 13 mm | 61 | |

When the answer was wrong (appearance only), the most common wrong #1 suggestions were diphenoxylate/atropine 2.5/0.025 mg, sulfamethoxazole/trimethoprim 800/160 mg,
donepezil 10 mg and pregabalin 150 mg: tablets with a very ordinary look in a very crowded group. Treat a shortlist as "things to check", not as an answer.

## How the simulation works (and its limits)

For each sampled database appearance it generates what the vision engine could report, then calls `identify()`:

- **Colour**: the engine's colour is drawn from a confusion table (white to gray 8 %, to yellow 5 %, to pink 2 %; pink to red 7 %, orange 5 %, white 7 %, purple 3 %; blue to turquoise 12 %,
  purple 7 %; and so on, about 15 to 35 % wrong for the harder colours). Two-tone capsules: both colours seen 88 %, only one 10 %, a repeated colour 2 %. A single-colour tablet shows a false second colour 3 % of the time.
- **Shape**: drawn from a table per true shape (round to oval 10 %; oval to capsule 18 %, capsule to oval 18 %; rectangle splits three ways; six-sided and
  eight-sided shapes read as round 60 %, ...), with a noisy aspect ratio. Shape unknown 10 % of the time.
- **Size**: true label size times a random error of up to plus or minus 8 %, and absent in 50 % of trials (camera not calibrated).
- **Imprint**: typed exactly (upper/lower case, with or without a space between sides), or with ONE error: wrong character (60 % of those look-alike OCR mistakes such as O/0, I/1, S/5), a missing character,
  an extra character, or two neighbouring characters swapped.

Limits to keep in mind:
1. Real photographs are not involved. Real colour errors depend on lighting, tablet coating and the camera; they may be worse than assumed.
2. The tuner (below) learned from this same simulation, so it is partly tuned to my assumptions about the noise. The colour/shape similarity is deliberately forgiving to compensate.
3. The test pills are drawn from the same database the identifier searches, so the "version held out" row is the honest one for an unfamiliar tablet.
   Even that row still has other manufacturers' looks of the same drug available. Drugs sold by only one labeler cannot be recognised when that version is hidden (those 4 % of trials are left out of that row).
4. The database holds up to 25 labelers per drug; real pharmacy stock includes versions we did not sample.
5. DailyMed entries contain mistakes made by the labelers; they are not corrected.
6. Each drug+strength is counted once per trial, but drugs with many looks (for example loratadine, acetaminophen) appear more often in the row-weighted sample. The drug+strength-weighted table shows the effect (a point or two).
7. "Hit" ignores immediate versus extended release and ignores the salt, so for example metoprolol tartrate 25 mg and metoprolol succinate 25 mg count as the same drug in this scoring.

## What was tuned

- Structure changes (largest effect): one result per drug + strength with the share-weighted mean of its looks mixed into the rank (so a drug sold in forty
  looks does not win just because one of them fits); a mild penalty for repeating the same generic; likelihood-style colour table (what the camera says given the label colour) instead of one flat "near colour" value;
  size tolerance that grows with size; fuzzy imprint tiers that depend on imprint length (2-character imprints now get a tiny fuzzy score, so appearance can decide); adjacent-swap tolerance;
  the imprint score no longer saturates at 0.97 before ranking, so ties are broken by appearance and popularity; a name/brand search that also works from the imprint box.
- Parameter search (`node test/id-eval.mjs --tune`, coordinate descent over 24 numbers): tuned on a random half of the DRUGS, checked on the other half that the search never saw.
  Held-out half before/after parameter tuning: appearance top 5 17.8 to 18.3 %, imprint #1 95.7 to 96.8 %, typo #1 69.2 to 69.2 %. The tuned values moved colour confusion up (3x more forgiving),
  shape confusion up, size tolerance down for small tablets, and the popularity prior to 0.25. The gain from parameter search alone is small (about half a point to one point); the structure changes carry most of the improvement.
- The appearance-only score is still capped at 0.6.

## Reproduce

```
node test/id-eval.mjs                          # 3000 appearances, seed 1337
node test/id-eval.mjs --by id --n 2000         # every drug+strength equally likely
node test/id-eval.mjs --noise 2                # stress test
node test/id-eval.mjs --tune --tn 300          # parameter search (about 20 minutes)
node test/id-eval.mjs --module X/pill-id.js --db X/pill-db.js   # compare another identifier/database
node test/test-id.mjs                          # unit checks against the real data
```
