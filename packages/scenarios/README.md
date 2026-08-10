# `@ue-shed/scenarios`

Portable interactive-gameplay scenario documents, timeline editing, checkpoint-aware seek planning,
and aligned runtime evidence. The package is intentionally headless: Workbench is one presentation
of the same artifact and pure operations available to a CLI, an agent, or another trusted host.

The experimental v1 document uses evaluated semantic actions as its authoring spine while retaining
raw input provenance, world conditions, interventions, and evidence as separately declared layers.
It does not claim that arbitrary gameplay can seek directly; `planScenarioSeek` restores a known
checkpoint and plans replay-forward work.
