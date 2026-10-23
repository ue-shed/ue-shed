# Game Text corpus

`pnpm corpus:generate` writes a Game Text corpus into a scratch Unreal project. It plants every
finding on purpose and writes down the right answer beside it. Use the corpus to check that the
Game Text index, its rules and its queries give exactly the right answers. Use it also for fuzz
runs at any size, and for scan-speed measurements at scale.

The answers come from the plan that built each case, never from running UE Shed. The planning
code imports no check, rule, index or reference oracle. When today's engine disagrees with an
answer, the corpus records both sides as a known defect (see [Known defects](#known-defects)).
[Plan 059](../../plans/059-game-text-query-and-rule-engine.md) uses this corpus as its ground
truth.

No generated output belongs in this repository. That covers packages, localization files, plans
and expected results.

## Run it

You need Node 26, pnpm and a UE5 editor with its C++ toolchain. UE 4.27 isn't supported.

```powershell
pnpm install
pnpm run build:typescript-packages

# Generate the canonical corpus into a new scratch project, then compare a scan with its answers.
pnpm corpus:generate --project E:/Scratch/GameText/Corpus.uproject --seed 1 --lines 256 --density 1 --root /Game/Fixture/Corpus
pnpm corpus:compare E:/Scratch/GameText/Content/Fixture/Corpus

# The same comparison as an integration test.
$env:UE_SHED_GAME_TEXT_CORPUS = 'E:/Scratch/GameText/Content/Fixture/Corpus'
node scripts/test.ts packages/game-text/src/corpus-fixture.integration.test.ts

# A fuzz run: generate, compare, edit, rescan, compare again.
pnpm corpus:fuzz --scratch E:/Scratch/GameTextFuzz --seed 73131 --lines 10000
```

Without a corpus folder or `UE_SHED_GAME_TEXT_CORPUS`, the comparison and the integration test
skip and print how to generate one. CI runs only the tests that need no Unreal:

```sh
node --test scripts/game-text-corpus.test.ts scripts/game-text-corpus-plan.test.ts scripts/game-text-corpus-ownership.test.ts scripts/game-text-corpus-scratch.test.ts
```

| Option          | Default                                  | Meaning                                                    |
| --------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `--project`     | required                                 | A new `.uproject` path. The generator creates the project. |
| `--seed`        | `1`                                      | Seed for every random choice.                              |
| `--lines`       | `10000`                                  | The least number of lines to write.                        |
| `--density`     | 2 to 8, growing with `--lines`           | Instances of each case, 1 to 12.                           |
| `--root`        | `/Game/Developers/<user>/GameTextCorpus` | Output folder, at least two levels below `/Game`.          |
| `--engine-root` | installed UE 5.8                         | Engine to build the plugin for and run.                    |
| `--clean`       | off                                      | Replace an earlier corpus this generator wrote.            |

Every case is always written, so a small `--lines` can produce more lines than asked for. In Git
Bash, set `MSYS_NO_PATHCONV=1`, or Bash rewrites `/Game/...` into a Windows path.

## Scratch projects only

The generator writes localization configuration and files as well as packages. It therefore
works only in a project it created itself:

- `--project` must point into an empty or missing folder outside every git repository and not
  through a linked folder. The generator writes a minimal `.uproject` and a marker file there.
- It refuses any project without its marker, and any marker whose `.uproject` was edited.
- `--clean` deletes only files listed in its ownership receipt, and only while they are
  unchanged. A foreign, edited or missing file stops the cleanup.

The runner builds `tools/unreal/UEShedCorpusGenerator` with `RunUAT BuildPlugin` into
`out/game-text-corpus-plugin/`, and keeps logs in `out/game-text-corpus-runs/`. It holds the lock
file named by `UE_SHED_UNREAL_LOCK` around every Unreal build and commandlet. Jobs that share a
machine must use the same path. Builds use at most eight parallel actions or half the processors.
Set `RAYON_NUM_THREADS` and `CARGO_BUILD_JOBS` to cap native scans.

## How it works

1. **The plan.** [`game-text-corpus-plan.ts`](../../scripts/game-text-corpus-plan.ts) is pure,
   seeded TypeScript. It draws every case, its text and its placement, and writes each answer
   next to the code that built the case. A case builds its text to have the values it drew,
   for example a source of exactly 40 UTF-16 units. The answer is that value; the plan never
   measures or parses text.
2. **Unreal writes it.** The commandlet reads the plan and writes exactly what it says, through
   Unreal's own APIs. It writes:
    - String Tables, DataTables, Blueprint variables, Blueprint pin defaults and Widget text;
    - a localization target, `UEShedCorpus`, with its gather config, manifest, archives and PO
      files for English (native), German, French and Japanese;
    - `.locres` files, through Unreal's writer, read back with Unreal's reader to check them.

    The commandlet makes no choices of its own. It derives editor GUIDs from the seed only so that
    graphs, nodes and pins serialize the same way every run.

3. **The comparison.** [`compare-game-text-corpus.ts`](../../scripts/compare-game-text-corpus.ts)
   scans the corpus through UE Shed's public APIs and compares every line in every culture with
   its answer. The comparison covers the line's identity, state, facts, unknown reasons,
   problems, signals and findings, with each finding's evidence. Anything missing, extra or
   different fails, unless it is a known defect.

New expectations set `findingFixes: true` and compare each finding's optional `fix`, with the
exact proposed-change shape: target, culture, namespace, key, source, previous translation and
replacement translation. Rename replacements are planted from the recipe's argument slots,
including nested plural forms. Missing, changed or unexpected fixes fail the comparison.
Retained version-1 corpora without this marker keep their original evidence-only assertions;
new generation and fuzz runs assert fixes. The portable fix tests also check the proposed-change
schema and today's TypeScript implementation without using it to produce expectations.

Both the comparison's native scans and the generator's Unreal subprocesses hold
`UE_SHED_UNREAL_LOCK`. They create the lease exclusively, record the owner and time, poll every
30 seconds while another job owns it, and release it after completion or failure. The collapse
probe runs under its parent's lease.

A second, two-line target checks Unreal's `IdenticalNamespaceAndSource` collapse mode on its own,
so the main target doesn't depend on how collapse mode behaves.

## What it contains

**Cases.** Each named case plants one behaviour and states the findings it must and must not
produce. Most come with a near miss just on the other side of a threshold. Together they cover:

- every built-in localization and source check, and the custom `pattern`, `length` and
  `forbidden_term` checks, character budgets and terminology rules;
- every native signal: `shared`, `duplicate_source`, `long`, `unresolved`, `conflicting`,
  `evidence_only` and `compiled_copy_differs`;
- every localization state, including `not_gathered`, `changed_since_gather`, `not_found`,
  `not_translated`, `needs_update`, `not_synced` and `unknown`;
- identity: the same key in two namespaces, culture-invariant text, String Table references that
  resolve, miss an entry or miss a table, and asset text under the package namespace;
- interactions: one line with several findings, and findings that suppress others;
- the different meanings of "characters" and "words": UTF-16 units, code points and visible
  length; whitespace splits and line-break spans; Unicode and Unreal whitespace.

A failure names its case, so it points straight at the code that built it.

**Background.** The rest of the lines are filler that can't produce a finding:

- the source kinds are split about 40% String Table entries, 30% DataTable cells and 10% each
  Blueprint variables, pin defaults and Widget text;
- the text includes format arguments, rich-text tags, line breaks, and accented and CJK words;
- each source is unique and below every length threshold;
- every culture has its own translation, which keeps the arguments, tags and line breaks and
  stays inside every length ratio;
- the native culture's translation equals the source.

Placement still brings some Unreal facts, which are part of the answers:

- Blueprint and Widget text carries `evidence_only`, because every saved place there is read-only.
- Every Blueprint variable also saves an empty editor category. It is its own line, named
  `blueprint-empty-category@<variable key>`, with state `unknown` and reason
  `unresolved_identity`.

Background pins use unwired pure nodes, so they have no compiled copy. Wired Print Text pins
appear only in cases. The old generator wired 70% of its pins, so scan-speed numbers that depend
on compiled copies aren't comparable with runs before this change.

## Translation stages

Each culture records three values separately: the PO `msgstr`, the archive translation and the
compiled `.locres` value. Cases cover all three stages agreeing, an import pending (the PO differs
from the archive) and a compile pending (the `.locres` lags the archive). Today's checks read the
latest stage: the PO while it isn't imported yet, otherwise the archive. The answers follow that.

UE Shed doesn't expose compiled values or how far a stage lags yet. The answers mark those fields
`notExposedYet`, and the comparison skips them until the engine reports them.

## Known defects

Where today's engine is wrong, the answer stays right and
[`game-text-corpus-defects.ts`](../../scripts/game-text-corpus-defects.ts) records today's output
beside it, with the reason. The comparison passes only while today's output matches the recorded
defect exactly. When a fix lands, the entry fails as stale and must be deleted. The comparison
prints the number of recorded disagreements by defect.

## Fuzz runs

A seed changes:

- the names, tokens and tag names inside each case;
- which of German and French a finding lands in;
- each case's source kind, where it allows more than one, its package and its position;
- the background text and the package sizes;
- the edits made before the rescan.

Each instance has its own tokens, so cases that compare lines group only with themselves.
Thresholds and argument counts stay fixed per case.

`pnpm corpus:fuzz` generates a corpus in a new scratch project and compares it. It then applies
seeded edits: source changes, PO and archive changes, a package added and a package deleted. Both
an incremental rescan and a full scan must match the edited answers and each other. Reports stay
in the scratch folder.

## Using it from another repository

The plan, the answer format, the localization writer and the diff depend only on Node and
Effect. Another host, such as Electroswag, can package them and connect its own scan through the
public `@ue-shed/*` APIs.
