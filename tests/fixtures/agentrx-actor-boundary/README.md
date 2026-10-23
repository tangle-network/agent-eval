# Recorded AgentRx actor boundary

These are selected bytes from the public AgentRx revision named by [sources.json](sources.json), under its [MIT licence](LICENSE.txt). No human annotation was authored for this fixture.

- [labels.json](labels.json) retains the original annotations for Tau tasks 2, 12 and 71. Task 71's root is the User's lamp selection after the assistant already requested clarification. Tasks 2 and 12 have Assistant roots that remain eligible.
- [observations.json](observations.json) retains only actual trajectory steps: task 71's clarification and User reply, and task 2's product tool output and incorrect assistant count. It excludes outer benchmark task instructions, expected actions/outputs and annotations.
- [legacy-calibration.json](legacy-calibration.json) retains the original twenty-item native calibration's labels, predictions and score, with its original receipt hash. This file is a historical calibration record, never a newly selected gold source. New admission must not change its result.

The integration flow reads the public loader from files, checks the recorded actor/evidence boundary, handles omitted actor metadata as unknown, and recomputes the immutable old receipt through the public scorer. It makes no model calls. Run `pnpm test tests/agentrx-gold-admission.integration.test.ts` in an admitted verification environment.
