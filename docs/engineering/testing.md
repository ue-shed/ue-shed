# Testing

Write many useful tests, not many shallow tests. Test at the lowest layer that can prove the behavior.

## Test types

- **Pure tests:** folds, diffs, validation, state changes, and scheduling.
- **Property tests:** codecs, round trips, ordering, convergence, and bounds.
- **Effect tests:** use `@effect/vitest` for typed errors, services/layers, cancellation, cleanup,
  timeouts, retries, and concurrency.
- **Integration tests:** real temp files, local servers, pipes, processes, and frames.
- **Protocol tests:** valid and bad messages, limits, versions, gaps, and reconnects.
- **Unreal tests:** real fixture assets, DataTables, rollback, Save, actors, focus, and recovery.
- **UI tests:** visible states and user actions through public services.
- **Visual tests:** shared primitives and a small set of key product screens.

Use mocks only when the real boundary is too slow, unsafe, or unavailable. A mock must not define the
contract it claims to test.

## Rules

- Test success and failure.
- Assert expected failures through the typed error channel rather than catching thrown decoder or
  Promise exceptions.
- Test cleanup and cancellation for every owned resource.
- Test slow consumers, stale sessions, reconnects, and partial support.
- Share protocol fixtures between TypeScript and C++.
- Keep the Unreal fixture contract readable without launching Unreal.
- Test UI meaning, not DOM shape or generated CSS names.
- Add a regression test for every fixed bug.

Coverage reports help find missed paths. A percentage is not the goal. Critical state machines,
codecs, errors, and recovery need deep coverage.

Observatory actor-stream tests compare encoder output with the checked-in binary contracts and
never rewrite them. To intentionally regenerate those fixtures, run
`pnpm --filter @ue-shed/observatory fixtures:generate`, then review the binary diff and run
`pnpm test packages/observatory/src/actor-stream-protocol.test.ts`.

The ordinary suite retains camera lock ownership guards. Process-kill camera recovery and the
50,000-entry localization performance budget run in explicit lanes:

- `pnpm --filter @ue-shed/cameras test:recovery` retains all four killed-writer boundaries.
- `pnpm --filter @ue-shed/localization test:performance` retains the full PO/archive scale input.

The Node project's default excludes `*.recovery.test.ts` and `*.perf.test.ts`; the package
configs explicitly include them. Run these lanes when changing camera persistence or localization
parsers respectively.

## Local verification

GitHub Actions runs the portable repository checks on every pull request, including PRs targeting
another feature branch. All hosted jobs, including Pullfrog, use standard GitHub-hosted Ubuntu 24.04
runners.
On pull requests, separate UAsset library and IO lanes run when their Rust, WASM, package, contract,
script, or fixture inputs change. Parser and inspection changes also trigger downstream IO
conformance; WASM-package-only changes do not. The website browser lane follows the site's transitive workspace dependencies,
saved fixtures, media, scripts and configuration. The SQLite Catalog oracle follows `crates/uasset-io`
and shared build inputs instead of every IO consumer change. Pushes to `main` and manual workflow
dispatches run all lanes as a backstop. Native-reader CLI and fixture integration tests run in the
conditional IO lane, not in the always-on repository suite. Run the complete portable gate locally with:

```powershell
pnpm check
```

The full local gate also retains packed-package and Data Authoring adoption conformance while those
hosted release and adoption flows are being redesigned.

`test:uasset-engine-matrix` honors `CARGO_TARGET_DIR` for its native reader. Set
`UE_SHED_UASSET_ENGINE_MATRIX_OUTPUT_ROOT` to keep disposable fixture projects, builds, and evidence
outside a worktree, including the legacy fixture generator; it defaults to the repository's `out`
directory.

When saved-asset regeneration is prohibited, set
`UE_SHED_UASSET_ENGINE_MATRIX_RETAINED_ROOT` to a completed matrix output containing both
`5.7/fixture` and `5.8/fixture`. This mode checks configured engine sources, runs fresh
`-VerifyOnly` reflection, and runs native/WASM/saved-review parity against those saves. It does
not build or regenerate the retained projects, or run the legacy generators. It reports those
legacy generation lanes as skipped; ordinary saved legacy regression tests still apply.

Run the conditional UAsset lanes independently with:

```powershell
pnpm run uasset:check:libraries
pnpm run uasset:check:io
```

Use `pnpm check` for full local verification. During local iteration, targeted checks help verify
individual changes quickly.

The ordinary Game Text Node suite runs all eight persisted differential join fuzz seeds and the
minimized regressions. The seeded sweep runs separately: `pnpm test:game-text:fuzz` runs 2,000 seeds,
and the hosted repository job runs it with 100. `UE_SHED_JOIN_FUZZ_SEEDS` and
`UE_SHED_JOIN_FUZZ_START` override the count and start. Non-persisted cases feed generated bytes directly to the real column importers;
persisted cases still exercise filesystem imports.

The sweep builds the native reader, which converts package text to columns. The ordinary native
join oracle runs eight persisted seeds. `pnpm test:game-text:fuzz --native` also runs the native
persisted sweep (32 seeds by default);
`UE_SHED_NATIVE_JOIN_FUZZ_SEEDS` overrides that count. Run it before a release that touches the
native join. The TypeScript sweep keeps its independent seed count above.

The heavier Game Text checks have explicit lanes:

```powershell
pnpm test:game-text:benchmark
pnpm test:game-text:scale
pnpm test:game-text:soak
```

The benchmark lane keeps the fresh-process failure, RSS watchdog, run deadline and cached-PO
measurement checks outside `pnpm test`. The scale lane retains the named 50,000-line/14-culture
quadratic-join regression and its timing budgets; the default suite checks the same counts,
paging, grouping and gates on 5,000 lines without wall-clock assertions. The lifecycle suite runs
two rounds per interruption phase by default and eight in the soak lane. The wrappers set
`UE_SHED_GAME_TEXT_BENCHMARK`, `UE_SHED_GAME_TEXT_SCALE` or `UE_SHED_GAME_TEXT_SOAK` to `1` and run
one file at a time. Responsiveness tests are included only when their dedicated wrapper enables them.

`pnpm test:game-text:responsiveness`, part of `pnpm check`, runs the production host stack over a
synthetic project and fails when a cold or warm build-and-open leaves the event loop without a
turn for longer than its budget. It checks stalls, not durations, and runs alone because a timer
gap measures the whole process.

Use `scripts/test.ts` through the package test commands for native fixture tests. It ensures the
native executable once and provides a temporary evidence cache scoped to that invocation. Package
layer and join tests reuse read-only header and extraction evidence for committed fixture roots;
each test builds its own writable index. Reader protocol tests and benchmark measurements still
perform fresh native reads.

The hosted workflow is `.github/workflows/portable.yml`. `scripts/ci-scope.ts` selects PR lanes using
a merge-base diff, includes deleted and renamed paths, and fails on an invalid Git range. Selection
and local-dependency regression tests run before dependencies are installed. The dependency check
rejects external, missing, absolute and untracked local references while allowing checked-in local
dependencies. It also runs in `check:static` and `check:precommit`.

`check:static` runs dependency, format, lint, Effect architecture, license, StyleX and architecture
regression checks before compilation. Contract checks follow package builds because they import
built protocol packages. `check:precommit` now runs the Effect architecture check on repository
sources in addition to testing the checker.

All jobs in `.github/workflows/portable.yml` use `ubuntu-24.04` GitHub-hosted runners. Changes to the
workflow itself enable both conditional UAsset lanes. The aggregate status requires the repository job to succeed and accepts only success or
an intentional skip from the conditional jobs, including the website lane. A failed selection job
blocks the aggregate gate. The Catalog job runs its SQLite-specific suite and differential oracle;
ordinary IO library tests remain in the IO job instead of running twice. Rust compilation uses sccache
with the GitHub Actions cache backend; pnpm uses the setup-node dependency cache. Evidence and failure diagnostics
remain GitHub Actions artifacts.

Hosted Rust is pinned by `RUSTUP_TOOLCHAIN` in the workflow, independently of the crates' minimum
supported Rust versions. Both UAsset jobs install the pinned prebuilt `wasm-pack` binary with checksum
verification instead of compiling the tool. Native/WASM parity uses the debug executable through
`ensureUassetExecutable`; set `UE_SHED_UASSET_EXECUTABLE` to test another built executable. Benchmarks
and release packaging still build optimized native binaries. The browser lane installs only
Chromium's headless shell, which both WASM browser smoke tests use.

Each UAsset evidence artifact includes `sccache-stats.json` and, when emitted, `sccache.log` with
warning-level server diagnostics. Inspect these for write failures alongside the hit rate; a Cargo
`Compiling` line alone does not establish a cache miss. Cache duration counters are cumulative across
concurrent requests, not job wall time. Both compiler and dependency caches use GitHub Actions
backends. Compare cold and warm hosted runs before adding target-directory caches or increasing
runner size.

The former `.depot/workflows/portable.yml` is removed so pushes after migration do not schedule a
second portable workflow in Depot. No release or Unreal runner is enabled by this migration.

### Optional local Rust compiler cache

[Kache](https://github.com/kunobi-ninja/kache) can share compatible Rust compilation outputs between
local builds and worktrees. GitHub Actions continues to use the sccache configuration above.
Install the prebuilt Windows package through the upstream Scoop bucket:

```powershell
scoop bucket add kunobi https://github.com/kunobi-ninja/scoop-kunobi
scoop install kunobi/kache
kache --version
```

For other platforms, follow the [upstream installation guide](https://github.com/kunobi-ninja/kache/blob/v0.28.1/docs/getting-started/installation.mdx).
To enable Kache only in this checkout, create the ignored `.cargo/config.toml` at the repository root:

```toml
[build]
rustc-wrapper = "kache"
```

Keep any existing Cargo settings when adding the wrapper. Kache must be on `PATH` in terminals
that run Cargo or pnpm. `RUSTC_WRAPPER` takes precedence over this setting, so an existing environment
override must be cleared or deliberately retained. Cargo commands and the repository's pnpm gates
then use the wrapper without changes to package scripts. Configure each worktree separately.
`kache init` configures Cargo for the whole user account; the checkout configuration above keeps
activation local. The default Windows store is `%LOCALAPPDATA%\kache`, shared across checkouts.

```powershell
kache doctor
cargo build --locked -p uasset-inspection
kache stats --last-build
kache why-miss uasset_inspection
```

An already populated target directory can make Cargo skip the compiler altogether. To verify reuse,
build the same package with two fresh `--target-dir` paths and inspect the second build's report.
Retain separate target directories for concurrent worktrees. Windows executable caching is disabled
by default because of external PDB paths; inspect bypass reasons before expecting every unit to hit.
Leave that default in place. Kache's adaptive incremental policy manages eligible units, so local
setup does not need to disable Cargo incremental compilation globally.

For one uncached diagnostic build, set `KACHE_DISABLED=1` in its environment. To remove checkout
activation, remove the `build.rustc-wrapper` setting from `.cargo/config.toml`. Neither action deletes
Cargo outputs or the shared compiler cache.

Run every process-level end-to-end journey with:

```powershell
pnpm test:e2e
```

The lanes can also run independently:

```powershell
pnpm test:e2e:cli
pnpm test:e2e:workbench
```

The Workbench command builds the production Electron app before launching it against the committed
fixture. During local iteration, reuse the existing build or open Playwright's interactive runner:

```powershell
pnpm test:e2e:workbench --no-build
pnpm test:e2e:workbench:ui
```

Workbench specs live under `apps/workbench/e2e`. Add route-level actions and accessible locators to
the shared `WorkbenchPage`, and use the shared fixture for app launch, teardown, screenshots, and
traces. Failure artifacts are written under `test-results/workbench`.

Installing dependencies also installs the repository-managed pre-commit hook. It runs
`pnpm check:precommit` (dependency paths, formatting, linting, Effect architecture, licenses, StyleX,
architecture regressions, type checks and contracts) before
Git creates a commit. The longer `pnpm check` gate is available for full local verification; the
hosted workflow runs repository checks and the applicable UAsset lanes described above.

### Timing local gates

`pnpm check:time <script>` runs a package script (such as `check`, `check:precommit` or
`check:unreal`) one command at a time and traces it:

```powershell
pnpm check:time check:precommit
pnpm check:time check --keep-going
pnpm check:time check:unreal
```

It expands `pnpm run` steps inside `&&` chains, so the trace shows the real commands. Every Node
process records a span, Vitest records a span per test file (split into setup, import and tests) and
per test, and Playwright records each E2E attempt with nested fixture, hook, assertion, browser API
and named test steps. This includes Workbench, live Map Review flows, website, recordings and
performance runners. Attempts retain project, file, worker, retry, repeat, expected and actual status;
skips remain explicit, failed attempts remain visible even when a retry passes. The console summary
lists the slowest E2E attempts. These timings come from our runner and include application launch,
readiness waits and cleanup through Playwright's fixture/hook steps; they require no Unreal-side
instrumentation. Attempt intervals use lifecycle wall time, including hooks and fixtures with
separate timeout budgets; `playwright.reported_duration_ms` retains Playwright's own accounted
duration. Unfinished steps retain their elapsed interval through the enclosing interruption boundary
and are marked as errors with `playwright.incomplete: true`, rather than successful zero-time steps.
Ordinary runs keep the list reporter without writing gate spans. Overriding
Playwright's `--reporter` also overrides the timing reporter.

Unreal runs record a span per UnrealBuildTool build and per editor or commandlet run.
Commandlet spans are split into engine startup, work and shutdown from the timestamps in the
project log. Child processes join the trace through `TRACEPARENT`; see `scripts/gate-trace.ts`.

Every non-Node subprocess a traced script starts (git, tar, npm, Cargo, `wasm-pack`, Electron,
native tools) also records a span, without changes to the script: the preload in
`scripts/trace-process.ts` wraps `child_process`. Calls a script already traces with
`traceProcess` are not recorded twice. Cargo spans carry `cargo.compiled_crates`,
`cargo.profiles` and `cargo.build_ms` when the output is captured, so compile time separates from
test time. Long scripts mark their phases with `stageSpans()` from `gate-trace.ts`: clean packing,
per-package packing and validation, Data Authoring adoption, each engine and phase of the UAsset
engine matrix, the owned fixture editor's session, Map Review flows and camera editor start/stop.
A child gets the innermost active span as its parent even when the script copied `process.env`
before starting that span.

Each run writes `out/gate-timing/<script>-<time>/` with `trace.json` (open it in
[Perfetto](https://ui.perfetto.dev)), the raw `spans.jsonl`, `summary.json` and one log per command,
and appends a line to `out/gate-timing/history.jsonl` for comparing runs. The console summary lists
the slowest commands and test files, repeated commands and the Unreal startup/work split.

### Unreal gate reporting

Legacy tagged text adds separate UE 4.27 and UE 5.3 fixture lanes using the independent
`fixtures/legacy-unreal-project` C++ project. The generator finds installed engines the same way
as the engine matrix; set `UE_SHED_UNREAL_427_ROOT` or `UE_SHED_UNREAL_53_ROOT` to use a different
installation. The generator uses
`UE4Editor-Cmd.exe` on 4.27 and `UnrealEditor-Cmd.exe` on 5.3:

```powershell
pnpm fixture:generate-legacy --update
pnpm fixture:generate-legacy
pnpm uasset:check:libraries
pnpm uasset:check:io
pnpm test packages/unreal-assets/src/legacy-fixture.integration.test.ts packages/game-text/src/legacy-fixture.integration.test.ts
```

Generation stages a clean project per version, builds its editor target, saves three assets, then
reloads them in a separate process for deterministic Unreal API evidence and saved package versions.
`--update` publishes the fixture-authored assets and evidence to `Generated/<version>`; normal mode
compares evidence and versions, never nondeterministic package bytes. Logs and per-version results
remain under `out/legacy-unreal-fixtures-*`. Missing installations are reported as skipped with the
exact variable to set. Report **4.27** and **5.3** separately, including failures and skipped versions;
neither a single-version pass nor an unavailable version completes legacy verification.

UE 5.3 headers do not compile with MSVC 14.40 or newer. When the newest installed toolset is too new,
set `UE_SHED_UNREAL_53_COMPILER_VERSION` (for example `14.38.33130`) to an installed older toolset.
The generator forwards it to UnrealBuildTool as `-CompilerVersion`. The same
`UE_SHED_UNREAL_<version>_COMPILER_VERSION` pattern applies to 4.27, but 4.27 builds with current
VS 2022 toolsets.

The portable Rust, native reader, Game Text, and native/WASM parity checks use the committed legacy
files without engines. Both generated version directories are required. The native FVector map
has one explicit `legacy_container_element_without_type_information` gap; other text and String
Table metadata must match the engine oracle. Generation remains pending until the user runs the
commands. See the [fixture README](../../fixtures/legacy-unreal-project/README.md) for optional
initial editor builds, evidence layout, and all handoff commands.

`test:uasset-engine-matrix` also runs optional 4.27/5.3 evidence comparison lanes and includes their
separate results in its report. Its required 5.7/5.8 lanes and source/native checks remain in place.

Always run the relevant Unreal checks on **both UE 5.7 and UE 5.8** for parser, codegen, fixture,
and Unreal integration changes. Report each version separately. If an engine or a required check is
unavailable, record that gap; a single-version pass does not complete verification.

For parser and source-codegen changes, run the engine matrix alongside `pnpm check`:

```powershell
pnpm test:uasset-engine-matrix
```

Repository scripts find installed engines the way `@ue-shed/engine` does: the Epic Games Launcher's
install list and `HKLM\SOFTWARE\EpicGames\Unreal Engine` keys, which cover engines installed on any
drive, then `Program Files\Epic Games`. Set `UE_SHED_UNREAL_57_ROOT` or `UE_SHED_UNREAL_58_ROOT` only
to use a different installation. This Windows lane requires both engines and their source. It
checks the committed 5.7 source models, regenerates the same recipes from 5.8 source, and rejects
changes to the shared native layouts or struct schemas. Tagged class declarations can differ;
the complete generated models remain in the evidence directory for review.

Each engine builds a disposable fixture, saves the native parser assets, and reloads them in a
separate commandlet process. Rust semantic conformance uses that engine's saved bytes and independent
Unreal API evidence; native/WASM parity and numeric projection contract checks use the same assets.
`ParserNative`, Blueprint graph/review, and text/nested Level Sequence assets are regenerated in
this lane. Blueprint membership, pin types/defaults and links are compared with fresh loaded graph
APIs; sequence timing, text keys and nested references are compared with loaded MovieScene APIs.
Other copied fixtures retain their committed 5.7 baseline. The lane retains logs, assets, models, and per-version `results.json`
under `out/uasset-engine-matrix-*`. It does not overwrite committed fixtures or use an open editor.

For plugin or live integration changes, also run the relevant plugin/authoring gates with
`UE_SHED_UNREAL_ENGINE_ROOT` pointing to each version. The existing `check:unreal` command still uses
the committed 5.7 fixture contract and does not replace the matrix.

The ordinary Vitest run prints every environment-gated real-Unreal suite before executing tests. A
gate is reported as `RUN` or `SKIP`, and skipped gates include the exact environment variable or
specialized command that enables them. The final Vitest skipped count should agree with this list;
an unexplained skip is a test-infrastructure defect.

Launcher registry entries can be missing or stale: an installed engine may have no entry, and an
entry may point at a removed installation. When discovery disagrees with the disk, set the explicit
`UE_SHED_UNREAL_*_ROOT` variables.

### Real-project scale testing

Fixtures cannot reach every size limit or content quirk that a production project does. Real-project
runs have found bugs the fixtures never hit, such as file size limits, `%LOCPROJECTROOT%` gather
filters and U+2028 in PO files. Contributors may run read-only scale tests against a local copy of a
real project. These rules apply:

- Treat the project as read-only. Never write to it, run Unreal gathers or commandlets that modify
  it, or change its source-control state. Use read-only source-control queries only.
- Put probe output under the gitignored `test-results/<project>/`.
- Never put the project's name, paths, content or measurements that identify it into commits,
  fixtures, docs or tests. Turn findings into generic fixture cases and regression tests.

### Solid component interactions

Run Solid component interaction tests independently with:

```powershell
pnpm test:components
```

Vitest keeps Node and component tests in separate projects. Component tests use jsdom, the Solid and
StyleX transforms, Testing Library accessible queries, and user-event interactions. Prefer a small
in-memory implementation of a component's public client contract; keep process, IPC, and native
reader behavior in the CLI and Workbench E2E lanes.

### Coverage discovery

Generate terminal, HTML, and JSON summary reports with:

```powershell
pnpm test:coverage
```

Reports are written to `coverage/`. Coverage includes untouched TypeScript and TSX source files so
zero-coverage modules remain visible, but it intentionally has no percentage threshold. Use it to
choose risk-based tests, not to reward incidental line execution.

V8 coverage only measures code executed inside Vitest workers. CLI and Electron E2E behavior runs in
child processes, so those entry points can appear uncovered even when their external journeys pass.
Read coverage together with `pnpm test:e2e`, not as a replacement for it.

Real Unreal verification remains an explicit, heavier local lane because it builds the fixture
plugins and runs fresh commandlets against committed fixture content:

```powershell
pnpm check:unreal
```

This command requires the configured local Unreal Engine installation. Run it before landing changes
to Unreal plugins, fixture generation, or live authoring mutation behavior. The fixture and plugin
builds record a fingerprint of their inputs (sources, descriptors and engine build) and skip
UnrealBuildTool while it still matches, which saves 4-8 s before every commandlet. Set
`UE_SHED_FIXTURE_REBUILD=1` to build anyway. Repository `-NullRHI` Unreal processes start with
`-ddc=NoShared`, which skips shared derived-data caches: a configured but unreachable shared cache
(for example `UE-ZenSharedDataCacheHost` off the studio network) otherwise adds about 10 s to every
engine start. Rendering editors keep the default graph, because in UE 5.7 `NoShared` also drops the
engine shader cache and they recompile engine shaders for minutes.

The authoring mutation test drives the UE Shed authoring plugin through Remote Control, as hosts
do, against the fixture editor `check:unreal` starts. It applies the inverse of its edits before
finishing and restores the exact committed bytes of the `Content/Fixture/Authoring` packages it
saves, so the editor and the fixture are left as they were. The Map Review wire
evidence step (`pnpm test:unreal-review`) additionally needs a fixture editor with Remote Control;
start it with `pnpm fixture:launch-authoring` and set `UE_SHED_REMOTE_CONTROL_ENDPOINT`. That trusted
gate runs both the protocol integration evidence and the Map Review gallery flows: restart/load,
37-camera soft-limit behavior, stale-bounds recovery, varied subject framing, and Natural/Clear
occlusion capture.

Run just the gallery flows during focused iteration with:

```powershell
pnpm test:flow:map-review
```

The command keeps the fixture map clean, removes only the sessions and Capture Runs it creates, and
retains projection, visibility, recovery, and raw PNG evidence in Playwright's `test-results` output.
It requires a live fixture editor; the command refuses to discard dirty map state and establishes
`/Game/Fixture/Cameras/L_CameraLoad` in a clean connected editor before running.
