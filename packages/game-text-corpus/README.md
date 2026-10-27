# `@ue-shed/game-text-corpus`

The application must provide `effect@^4.0.0` as a peer dependency. Reuse one compatible
Effect installation across the application and UE Shed libraries.

Check a host's Game Text index against a generated Unreal corpus. UE Shed's corpus generator
(`pnpm corpus:generate` in the UE Shed repository) writes a scratch project whose every line has
a planted right answer: its state, facts, problems, signals and rule findings in each culture.
This package reads that plan and those answers, scans the corpus through the host's index, and
reports every disagreement.

```ts
import { Effect } from "effect";
import { compareGameTextCorpus } from "@ue-shed/game-text-corpus";

const result = await Effect.runPromise(
	compareGameTextCorpus("E:/Scratch/GameText/Content/Fixture/Corpus").pipe(
		Effect.provide(hostGameTextIndexLayer)
	)
);
if (result.triage.unexpected.length > 0 || result.triage.stale.length > 0)
	throw new Error("The index disagrees with the corpus's answers.");
```

- The comparison requires `GameTextIndexRefresh` from `@ue-shed/game-text/index`: the host's
  Project Index, cache root and index steps. The host owns the runtime exit.
  `gameTextCorpusIndexLayer({ executable, cacheRoot })` is UE Shed's own composition, reading
  packages with the given `uasset` executable.
- `changedFiles` scans only the files changed since the index's last scan of the corpus.
- A main corpus has a collapse probe beside it, a second project the comparison scans through the
  same index. A missing plan, answers or probe fails with `GameTextCorpusError`.

The result carries the `expected` answers, the `actual` subjects the scan produced, the probe
`observations`, every `difference`, and its `triage`: `unexpected` differences fail, `pinned` ones
match a known defect exactly, and `stale` pins no longer match and fail.
`formatCorpusComparisonSummary` prints the pinned count by defect.

The comparison never launches Unreal and never changes the corpus. A host that shares the machine
with Unreal holds its own lock around the call.

The package also exports the corpus format: the plan (`decodeCorpusPlan`), the answers
(`decodeCorpusExpectations`, `diffCorpus`), the known defects and the localization files a plan
writes (`corpusLocalization`).
