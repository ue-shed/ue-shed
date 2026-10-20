# Blueprint text diagrams and Pele — 2026-10-17

This is a feasibility experiment, not a product contract or an adopted diagram language.

## Finding

The architecture comparison on **2026-10-18** supports a **dedicated named-port diagram module in a
small Pele source fork**, with a public programmatic model and a replaceable layout stage. Keep the
saved Blueprint projection authoritative in UE Shed and translate it into a generic port-graph view.
Use Pele's existing layout, text metrics, SVG, accessibility and hosting machinery where it fits.
Ordinary Mermaid remains a useful node-level overview export.

The initial runtime adapter below only dispatched to the same custom SVG renderer as the direct
path. It did not establish an architectural advantage for a standalone renderer. The later source
experiment actually reuses Pele's layout and compares it with extending the flowchart pipeline.

## Architecture comparison — 2026-10-18

The disposable source fork pins Pele **1.6.0**, commit
`659c3593ce43794dce7ec7ab45d424ad2de182a5`, retaining its MIT license. Experiments, source changes,
private diagrams, raw samples and the optional ELK installation stay in ignored output under
`out/blueprint-diagrams/architecture` and `out/blueprint-diagrams/pele-source`.
No maintained viewer or workspace runtime dependency was changed.

Three actual paths share the same card and pin geometry:

1. A programmatic port model rendered at saved coordinates.
2. A dedicated `portGraph` parser/module using Pele's layered layout and fixed endpoint offsets.
3. Flowchart node/edge metadata carrying named ports, propagated through its database, graph builder,
   compound layout and renderer. This uses existing block YAML syntax, with no lexer change.

The third path is syntactically readable by stock Pele, which draws a node-level fallback and ignores
ports. It must use block metadata: the existing lexer closes inline metadata at the first unquoted
`}`, and does not support nested inline objects. Port IDs cannot be added by treating `A.pin` as an
endpoint without a compatibility decision, since that spelling already works as a node ID.

Both new source paths preserved endpoints across all **116** graphs in the two real assets, with
zero node overlaps in their automatic layouts. The compact text round-trips the **view model**,
including pin order, types/default labels and saved positions. It does not archive every native
Blueprint field; the earlier verbose carrier proves a different fidelity boundary.
The largest selected graph has **275 nodes, 1,075 pins and 347 edges**.

Warm Node 26.5 timings use four warmups and 13 samples with a fixed headless text measurer. Times
exclude asset extraction, disk IO and DOM insertion. Layout includes measurement/validation; SVG
emission alone reuses an existing scene. These figures describe this implementation and machine.

| Largest graph operation          |  Median |
| -------------------------------- | ------: |
| Dedicated compact text parse     |  1.3 ms |
| Flowchart metadata parse         |  8.8 ms |
| Pele measurement + auto layout   |  3.0 ms |
| SVG emission from existing scene |  3.8 ms |
| Dedicated model → auto SVG       |  6.0 ms |
| Dedicated text → auto SVG        |  7.4 ms |
| Flowchart ports text → auto SVG  | 17.2 ms |
| Model → SVG at saved positions   |  3.8 ms |

An otherwise idle Chromium 154 session at 1280 × 800 measured 7.2 ms for dedicated model rendering,
7.9 ms from compact text, and 18.1 ms for flowchart text. Warm browser canvas measurement yielded
6.0 ms for dedicated model rendering. Full insertion/forced layout plus two animation-frame
callbacks took a median **50.5 ms** for the dedicated graph, comprising **6,851 DOM elements**.
These callbacks approximate display readiness; they are not an instrumented GPU paint measurement.
Ninety scripted transform-only pan frames had a 16.7 ms median interval and none exceeded 25 ms.
The first run overlapped regression testing; `browser-results-idle.json` is the authoritative browser
sample. A renderer should cache geometry and transform it while panning, rather than regenerate SVG.

Bundles were independently bundled/minified with esbuild for the browser and gzip-compressed:

| Export surface                       | Minified bytes | Gzip bytes |
| ------------------------------------ | -------------: | ---------: |
| Dedicated model/layout/SVG functions |         42,188 |     18,831 |
| Dedicated diagram + Pele core/mount  |         66,878 |     28,582 |
| Flowchart ports + Pele core/mount    |        133,110 |     51,808 |
| Stock flowchart + Pele core/mount    |        127,495 |     49,623 |

The flowchart extension's incremental bundle cost is small. Its downside is coupling named-port
semantics to shared flowchart behavior, including grouping, mixed directions, shape borders,
self-loop routing, automatic direction changes and edge spreading. The experiment supports LR;
complete arbitrary-direction/grouped support is not implemented. A dedicated flat port-graph module
can reuse the low-level layout without modifying flowchart or compound-layout semantics. Its small
integration changes are detection, registry generation and generated type/entry files. The custom
parser, geometry and rendering still require maintenance; dependency-free does not mean cost-free.

### Layout quality and optional ELK reference

Saved positions plus generic cards created **183 overlapping node pairs** on the largest graph,
versus zero with either automatic layout. They therefore do not reproduce Unreal's layout: saved
coordinates need compatible node measurement/presentation. The two automatic paths each still had
one foreign-node intrusion when sampling the actual rendered curve every eight world pixels.
This is sampled evidence, not a proof of obstacle-free routing. The prototype's comment cards,
split/hidden pins, expression presentation and clipping are not Unreal editor fidelity.

Pele's low-level layout supports fixed cross-axis offsets, but its cycle reversal may change an
edge's physical endpoint side. The prototype explicitly routes those returns while retaining east
outputs and west inputs. The real corpus had only one such return, so it provides little cycle
coverage; separate synthetic cycles and self-loops were tested. An isolated-node addition moved
29 of 275 existing nodes after removing global translation, by up to 66.5 px: the layout is
deterministic but not a stable incremental editor layout.

ELK **0.12.0**, with fixed port positions and orthogonal routing, was measured as an optional
quality reference using the same node dimensions and SVG cards. The largest real graph's layout
took about **186 ms**, versus about **4 ms** for Pele in that comparison, and its bounding area was
about **34% smaller**. The gameplay graph was about **68% smaller**. ELK's actual orthogonal SVG
paths had zero sampled foreign-node intrusions on the largest graph and a 100-node cyclic case.
The renderer must preserve the router's geometry: smoothing ELK's bends with an unrelated cubic
interpolator introduced intrusions, so the verified outputs use its linear orthogonal segments.

For a synthetic 1,000-node/1,330-edge chain with skip links, Pele's layout took 13 ms and ELK about
1.27 s. With 1,605 edges including cycles/self-loops, Pele took 32 ms and ELK 3.13 s. These are
specific generated topologies, not a general scaling law. The tested ELK bundled distribution adds
1,609,707 bytes, or 471,876 gzip bytes; a reduced custom build was not evaluated. ELK is therefore a
candidate for a separately loaded worker-backed quality mode, rather than an unconditional default.
Its measured quality advantage also argues against hardwiring Pele's layout into the public model.

### Recommended public shape

Keep four explicit boundaries: Blueprint evidence → generic port model → measured/layout scene →
SVG or host viewer. Text parse/format is another way to obtain that model. The CLI and ordinary
library consumers should pass models directly rather than serialize and reparse text. Provide
headless exports independently of the optional Pele text dispatcher/mount integration.

The model needs stable node/owner-scoped port identities, typed endpoints, ordering, optional saved
geometry and extensible presentation data. Native provenance, parser gaps and complete Unreal type
records stay with the Blueprint projection. Defaults, source identity and display policy must not be
collapsed into renderer-specific color strings or guessed connectivity. Unsupported node types need
a truthful generic presentation; unresolved links and missing geometry need explicit diagnostics.

Expose measurement, layout and scene rendering separately. A scene should contain usable bounds,
node/port geometry, routed paths and stable hit targets. Prefer backend-neutral path commands over
leaking Pele's internal triple-array routing representation. Let a host replace layout, measurement,
presentation and theme policy. Keep pan/zoom, selection and inspector state outside the domain model.
Saved, automatic and optional higher-quality layouts should use the same scene contract.

Pele's current `register()` cannot introduce a new detector keyword or extend its closed TypeScript
model union. Its core `render(model)` also accepts only objects returned by its own `parse()` via a
WeakMap; arbitrary structurally valid programmatic models are rejected. A useful maintained fork
needs explicit public model/scene entry points, and ideally a general registration/detection hook.
The experiment already exposes dedicated model/layout/render functions without weakening the core
WeakMap rule. A host can later add asynchronous worker orchestration without changing the model.

This recommends a scoped Pele fork plus a generic module, not a full Unreal graph editor. Before
product adoption, close the routing intrusion, test denser real cyclic graphs and nested groups,
define pin hierarchy/visibility and comment ownership, and add a bounded/cancellable layout worker
path. Use standard Mermaid export for broad interoperability: `portGraph` is an extension dialect
and will not render in unmodified Mermaid consumers.

Validation: the modified source typechecks; all **6,699** upstream/added tests pass (**103 skipped,
two todo**, one skipped test file). **114** existing flowchart documentation examples produced
byte-identical SVG against the published 1.6.0 package. The new adapters also passed all five saved
fixture graphs on **UE 5.7** and all five on **UE 5.8**, using the earlier loaded-Unreal conformance
evidence below. No native parser or Unreal integration code changed, so the engine matrix was not
rerun for the diagram-only source extension.

Primary references: [Pele API](https://pele.run/api),
[fixed offsets in layered layout](https://github.com/obsidianmd/pele/blob/659c3593ce43794dce7ec7ab45d424ad2de182a5/src/layout/layered.ts),
[core model dispatch](https://github.com/obsidianmd/pele/blob/659c3593ce43794dce7ec7ab45d424ad2de182a5/src/core.ts),
[ELK port constraints](https://eclipse.dev/elk/reference/options/org-eclipse-elk-portConstraints.html),
[elkjs](https://github.com/kieler/elkjs).

## Initial carrier and runtime-adapter experiment

- [Text and SVG prototype](../../scripts/blueprint-diagram-prototype.ts): export, parse, named-pin SVG,
  and standard Mermaid overview generation using existing `@ue-shed/blueprints` helpers.
- [Fixture runner](../../scripts/experiment-blueprint-diagrams.ts): WASM projection validation,
  loaded-Unreal evidence comparison, a disposable Pele patch, assertions, timings and artifacts.
- [Caller-selected asset runner](../../scripts/experiment-blueprint-diagram-asset.ts): all-graph text
  round trips and direct/Pele equality, with a selected graph's three rendering outputs and timings.
- [Standalone report](../../scripts/blueprint-diagram-report.ts): renderer selection, zoom/pan,
  source text and browser assertions. It does not change the maintained viewer.

The `blueprint v1` carrier preserves each complete `BlueprintGraph` record. Node titles, positions,
pin directions and connections have dedicated syntax; native metadata remains in JSON tails.
Aliases derive from node GUIDs (or object paths) and pin IDs, with collisions rejected. Pin aliases
are scoped by owner. Arrays retain their saved order. Unknown commands, unsupported versions and
ambiguous identities fail. Unresolved native links remain explicit records, with omitted SVG wires
counted separately. The carrier does not reconstruct `.uasset` bytes or the full Blueprint asset.
The accompanying evidence JSON retains source outcome, diagnostics and the complete projection.

This metadata-preserving carrier is deliberately verbose. It proves fidelity, rather than deciding
the compact syntax people should write. A production text view needs a separate decision about
which display facts it includes and how omitted metadata remains accessible.
The research scripts use Node hashing and filesystem adapters; they are not a new browser entry point.

## Pele boundary

The experiment pins **Pele 1.6.0**, installed only in ignored output. Its package has no runtime
dependencies and retains its MIT license in the disposable fork. The regular package and workspace
dependency manifests are unchanged.

`register()` alone cannot recognize a new diagram keyword: the detector table is closed. The runner
first asserts this failure, copies the published distribution, and adds one detector entry. It
records the exact replacement and original/patched SHA-256 values in `pele-runtime-patch.json`.
A maintained source extension would also need to integrate `DiagramType` and model/registry types;
the runtime patch is not a complete published TypeScript extension.

Pele preprocesses Mermaid syntax before calling a diagram parser. The carrier encodes entity/comment
characters inside JSON strings as Unicode escapes so literal `#quot;`, `&amp;`, `%%`, markup and
Unicode survive that stage. SVG labels and attributes are separately escaped. Tests cover those
strings, duplicate identities, repeated pin IDs on different owners, cycles and unresolved endpoints.

References: [public API](https://pele.run/api),
[core](https://github.com/obsidianmd/pele/blob/main/src/core.ts),
[detector](https://github.com/obsidianmd/pele/blob/main/src/detect.ts),
[registry generator](https://github.com/obsidianmd/pele/blob/main/scripts/gen-registry.mjs).

## Evidence

Windows, Node **26.5.0**, Pele **1.6.0**. The fixture run exercised both saved Blueprint fixture assets
on UE **5.7.4** and **5.8.3**, totaling ten graphs. Every graph survived text export/parse with deep
equality, and direct/Pele SVG equality passed. Both review event graphs contain 11 nodes, 30 pins
and five wires. Fresh `-SavedReviewOnly -VerifyOnly` commandlets passed on both engines with zero
errors/warnings. Their loaded graph paths, identities, coordinates, pin types/defaults and per-pin
links match the saved projections after the documented colon/dot path normalization.

The retained fixture projects were used read-only; no assets were regenerated. The full parser
engine matrix was not rerun because this experiment changes no parser, codegen or Unreal integration.

An explicitly supplied private project provided a separate stress case. A local scan examined
4,546 `BP_`, `WBP_` and `ABP_` candidate files: 2,918 were decoded, 1,627 were rejected by the current
saved-Blueprint reader, and one exceeded its 64 MiB input limit. These counts describe that candidate
set; they do not establish the largest graph among unsupported files or other asset naming schemes.
Project names, paths, graph data and generated diagrams remain in ignored local output.

| Private cohort                   | Graphs in asset | Nodes in asset | Selected graph nodes |  Pins | Wires |
| -------------------------------- | --------------: | -------------: | -------------------: | ----: | ----: |
| Gameplay asset                   |              97 |          1,534 |                  211 |   722 |   215 |
| Largest decoded individual graph |              19 |            440 |                  275 | 1,075 |   347 |

All 116 graphs across those two assets passed text round trips and direct/Pele SVG equality. Both
reads were **partial**: the first reports 183 native node-subclass tails and 52 incomplete definition
gaps; the second reports 24 and eight respectively. Neither reports a topology gap under the existing
`isBlueprintTopologyGap` classification. The selected graphs render every decoded wire, with zero
unresolved endpoints. This does not prove complete Unreal editor behavior or presentation.

The larger graph's carrier is 1,034,547 bytes; its named-pin SVG is 783,535 bytes. The standard
Mermaid overview is 32,295 bytes and its stock-Pele SVG is 277,667 bytes. Pele's default 50,000-character
source limit rejects the custom carrier. The caller-selected runner records that result, then
supplies explicit limits based on the already-decoded graph. The standard overview fits the default.

Initial warm medians for the larger graph were approximately 4 ms for graph-to-SVG, 29 ms for
carrier parse plus SVG, 29 ms through the Pele adapter, and 8 ms for the simpler Mermaid overview.
These are small local samples, not a cross-library performance claim. File reads, WASM extraction,
browser DOM insertion, layout and paint are excluded. The overview has different visual semantics.
One browser observation mounted the 6,849-element named-pin SVG and waited two animation frames in
about 70 ms; the 3,073-element overview took about 49 ms. This is not a frame-rate or interaction
benchmark. Raw samples and evidence are retained in the local results.

## Limits and next decision

The direct renderer reuses reference card geometry and wire paths. Native node dimensions vary, so
these generic cards overlap at some saved coordinates. Comments are not inferred to own neighboring
nodes. Reroutes, compact getters, split pins, generated editor titles/icons and hidden/default pin
presentation need deliberate display treatment. Pele's stock flowchart layout also lacks named-pin
endpoints. Neither result is an exact Unreal editor reproduction.

The remaining substantial work is readable presentation: class-sensitive geometry, preserving or
rebuilding layout, focused subgraphs and interaction on large graphs. A Pele adapter is feasible,
but this experiment found no reason to make Pele a dependency of the authoritative graph model.

## Reproduction

Use the repository's Node 26 toolchain. Build the existing inputs if their distribution files are
absent:

```powershell
pnpm --filter @ue-shed/protocol build
pnpm --filter @ue-shed/blueprints build
pnpm run uasset:build:wasm
npm install --prefix out/blueprint-diagrams/pele --ignore-scripts --no-package-lock --no-audit --no-fund pele@1.6.0
node --import tsx scripts/experiment-blueprint-diagrams.ts
```

Repeat `--fixture-root <fixture>` to supply retained saves from both engines. Repeat
`--evidence-root <directory>` in the same order to compare fresh commandlet evidence; otherwise the
fixture's existing `FixtureExpected/parser-targets` evidence is used. The runner writes a standalone
`report.html`, per-graph `.bpgraph`, `.mmd`, SVG variants, source evidence and raw timings under its
`--output` directory (default `out/blueprint-diagrams/results`).

For a caller-selected stress case, first prepare the disposable fork with the fixture runner, then:

```powershell
node --import tsx scripts/experiment-blueprint-diagram-asset.ts --asset <saved-blueprint.uasset> --output <private-output-directory>
```

It selects the largest decoded graph by node count, or accepts `--graph <name>`. Keep private outputs
outside tracked source. It checks the source SHA-256 before and after the run. Fresh engine checks
use discovered or explicitly configured engine roots and retained generic fixture projects, with
`-run=UEShedBuildFixture -SavedReviewOnly -VerifyOnly -SavedReviewEvidence=<directory>`.
