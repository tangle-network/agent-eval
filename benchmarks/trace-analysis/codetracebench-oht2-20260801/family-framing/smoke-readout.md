# Family-framing smoke readout — arm KILLED (2026-08-03)

Pre-registration: [`preregistration.md`](./preregistration.md) (gates committed before any paid run).

## OpenHands pair (CLEAN instrument: 0/12 and 1/12 failed runs)

| Arm | micro F1 | recall | precision | findings | pad/run | failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stock | 0.3023 | 0.250 | 0.382 | 34 | 1.17 | 0/12 |
| framing | 0.2151 | 0.192 | 0.244 | 41 | 2.45 | 1/12 |

- **No-harm gate VIOLATED**: 0.2151 < 0.3023 − 0.05, robust to the one rate-limited run (dropping that case-rep from both arms: 0.3291 vs 0.2299).
- **Pad-ratio kill component TRIPPED**: 2.45/1.17 = 2.1× > 1.6× threshold.
- Paired recall delta −0.1786, 95% CI [−0.3571, −0.0119] (excludes zero, n=6 clusters).
- Mechanism: coverage framing raises enumeration (34→41 findings) but sprays — far-gold predictions rise 22→34 and precision collapses.

## Terminus2 pair (INVALID instrument day — recorded, not used)

stock 0.2533 (5/12 failed), framing 0.1370 (4/12 failed).
Both runs exceed the 10% failed-run validity bar; the failures are z.ai seat degradation under load (429 request-limit + long-reasoning aborts; a single-call probe succeeds instantly), and the stock-T2 run additionally overlapped another LLM batch for ~7 minutes after an operator mutex error (ledgered).
Directionally consistent with the OpenHands kill; carries no evidential weight.
The pooled pre-registered gate table therefore cannot be computed; the arm dies on the clean OpenHands half alone, which the pre-registration's no-harm gate permits.

## Decision

**KILL family-framing** (hand-authored coverage instructions) — the fourth consecutive hand-written prompt arm to fail against stock this campaign.
Retained value: the Phase-1 decomposition stands — the far class (48.9% OH / 46.5% T2 of gold mass vs 14.4% mini-SWE; snapFar counterfactual +32.3pp / +25.4pp) is the measured target for the next arm.
Next arm, evidence-ranked: family-GEPA — the repo's optimizer trained on the tuning-legal OH/T2 dev pools with the objective grader, the only intervention class that has ever survived certification here.
