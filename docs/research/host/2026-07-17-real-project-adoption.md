# 2026-07-17: real-project Data Authoring adoption

Status: host onboarding technically verified and left ready for owner visual testing. The first
UI-only artifact is preserved separately as a failed-readiness experiment.

## Question

Can the Data Authoring browser slice coexist inside a representative existing Unreal and Perforce
workspace without changing the project's Unreal build, existing files, or source-control state?

This attempted the second-stage experiment proposed by
[`2026-07-17-agent-adoption-eval.md`](2026-07-17-agent-adoption-eval.md). It tests host-toolchain
coexistence only. It did not test functional host onboarding: the target retained the template's one
in-memory `DT_Encounters`, did not run `ShedHostLive`, and did not read `Arif_MBResearch` assets.

## Method

- Existing project: `E:\Perforce\Arif_MBResearch` (Mana Break Unreal project).
- Adopted target: `E:\Perforce\Arif_MBResearch\Tools\UEShedDataAuthoring`.
- UE Shed source commit: `6618a0423f46b5766c864f2404ecb562b77698d9`.
- Agent: OpenCode with `opencode-go/grok-4.5`.
- Harness: pure JSON run, credential-hostile environment, external directory access allowed, task
  delegation and web access denied.
- Ownership edit: only the applied theme's `colorAccent`, changed to `#ff6b6b`.
- Source control: no `p4 add`, `edit`, `reconcile`, or `submit`; the final target is neither opened
  nor mapped as a depot file.

The project had no existing `package.json` or pnpm workspace, so the host was intentionally isolated
under `Tools/UEShedDataAuthoring`. Existing Unreal configuration and build files were not modified.

## Timing and result

| Stage                                                        | Duration | Result  |
| ------------------------------------------------------------ | -------: | ------- |
| OpenCode UI transplantation, install, and build verification |  137.2 s | PASS    |
| Independent UI target verification                           |    6.9 s | PASS    |
| Real project catalog discovery                               |        — | NOT RUN |
| Real saved table opening                                     |        — | NOT RUN |

The agent used 23 steps and 31 tool calls, with 57,257 input, 1,568 output, and 3,697 reasoning
tokens. OpenCode reported USD 0.31596. The retained transcript contained no npm- or GitHub-token-shaped
findings and stderr was empty.

Independent verification built 217 modules. Production output included 207.44 kB of JavaScript and
14,364 bytes of extracted StyleX CSS; the verifier found the adopter-owned `#ff6b6b` accent and all
29 declared entries.

The Vite development host loaded successfully in the collaborative browser. The in-memory table,
grid, cell evidence, and reload action rendered without application console errors at a 1440 px
viewport. This is browser-demo evidence, not project-integration evidence.

## Findings

1. **Cross-drive materialization is broken.** The kit on `C:` rejected the target on `E:` as though
   it contained the source kit. Node's `path.relative` result across Windows drives makes the current
   containment check a false positive. The agent materialized into a same-drive temporary directory,
   copied the tree to the declared target, and updated the generated report path.
2. **Offline install is machine-store-sensitive.** The default pnpm store lacked an offline tarball
   for `@stylexjs/rollup-plugin@0.19.0`. The successful command selected the populated pnpm v10 store
   at `C:\Users\Ryzen\scoop\apps\pnpm\current\store\v10` and used the template's pinned
   `pnpm@10.32.1` through Corepack.
3. **The narrow-host acceptance check fails.** At 390 px the route overflows horizontally: the
   manifest metrics, table controls, grid, and detail pane extend beyond the viewport. The runtime
   remains error-free, but the result is not acceptably usable at the claimed narrow-host size.
4. **No root integration was necessary.** Because this Unreal workspace has no JavaScript host
   toolchain, a self-contained subtree coexists cleanly. A later experiment should cover an existing
   pnpm/Vite host where dependency and configuration merging are unavoidable.
5. **The central integration was absent.** The manifest copied the UI, SDK contract, and an
   `in-memory-authoring-client.ts`. It did not copy the authoring/catalog/assets/connection/host
   kernel, start Node authority, or provide a browser transport. Seeing one table was therefore the
   expected template behavior, not evidence about `Arif_MBResearch`.

## Preserved artifact

The incomplete UI host, dependencies, production build, provenance record, lockfile, and adoption
report remain under `E:\Perforce\Arif_MBResearch\Tools\UEShedDataAuthoring` for diagnosis. Do not
use it as the onboarding demo. Run its limited verifier with:

```powershell
cd E:\Perforce\Arif_MBResearch\Tools\UEShedDataAuthoring
pnpm verify -- --expected-accent=#ff6b6b
cd app
pnpm exec vite
```

The local agent prompt and transcript remain in ignored
`test-results/data-authoring-real-project/` evidence.

## Remediated functional onboarding

After the UI-only result was correctly reclassified, the kit gained the missing production
boundary: a schema-validated browser HTTP client, a copied Node `ShedHostLive`, the saved-project
catalog/reader kernel, portable functional verification, and target-local session storage. The
native catalog was changed from one process per `.uasset` to one bounded, parallel `uasset catalog`
process. Catalog discovery remains read-only; opening a table reads its saved package through the
existing versioned authoring snapshot contract.

The remediated host is staged at
`E:\Perforce\Arif_MBResearch\Tools\.UEShedDataAuthoring-next2`. It uses the current working-tree
implementation over source baseline `6618a0423f46b5766c864f2404ecb562b77698d9`; this distinction is
recorded because the implementation had not been committed when staged. The earlier
`Tools\UEShedDataAuthoring` UI-only artifact was not overwritten.

| Stage                                                   | Duration | Result |
| ------------------------------------------------------- | -------: | ------ |
| Materialize remediated kit                              |    0.9 s | PASS   |
| Online pnpm install (158 packages)                      |    6.3 s | PASS   |
| Copied browser build and server typecheck               |    < 2 s | PASS   |
| Direct cold native catalog, 8 workers                   | 184.06 s | PASS   |
| Copied HTTP host catalog plus open-first-table verifier |  191.5 s | PASS   |

The native catalog scanned 174,026 `.uasset` files and returned 555 saved DataTables. The copied
host then opened
`/Game/Demo/CombatCamera/DT_EnemyCameraConfig.DT_EnemyCameraConfig`. Source-side adoption
conformance independently materialized the same 63-entry closure, built the copied Rust reader,
discovered all 12 checked-in fixture tables, and opened the composite fixture table.

Two onboarding frictions were observed. `corepack pnpm` selected the wrong major version for a
nested run, while `pnpm.exe` honored the target's pinned pnpm 10.32.1. The pnpm offline store was
also drive-local and lacked the E:-drive tarballs, so the documented offline install failed and the
normal network install succeeded. Neither issue touched Unreal or Perforce state.

The staged host is serving `http://127.0.0.1:4174` and returns HTTP 200. Automated visual inspection
could not be completed because the collaborative preview required authentication and its fallback
reported no available browser. This is recorded as a visual-test infrastructure limitation, not an
integration pass. The catalog and selected-table operation themselves passed through the exact
browser-facing HTTP endpoint. No `p4 add`, `edit`, `reconcile`, or `submit` was run.

## Project-scale catalog remediation

The first functional implementation still read every complete package and decoded every DataTable
row before returning any catalog output. That made every page load a 184.06-second opaque cold scan.
The remediated catalog now reads a bounded package prefix, obtains `total_header_size`, reads only
that header, resolves export class paths, and emits metadata-only table descriptors. Row payloads
are decoded only after table selection.

Native progress is emitted every 1,000 assets and projected through the schema-validated host client.
The browser displays enumeration, processed/total assets, cache hits, tables found, cache writing,
and completion. The adopted host stores its versioned index at
`.ue-shed/catalog/index-v1.json`; the 37.37 MiB index keys 174,026 entries by absolute path, size, and
modified time. Refresh reparses only changed signatures.

| Measurement                                              | Duration | Result          |
| -------------------------------------------------------- | -------: | --------------- |
| Old complete-file native cold scan                       | 184.06 s | 555 descriptors |
| Header-only native physical-cold scan                    |  87.22 s | 556 descriptors |
| Header-only copied host, cache miss with filesystem warm |   9.63 s | PASS            |
| Header-only native warm index                            |   4.73 s | PASS            |
| Copied HTTP host warm index plus first-table open        |   6.56 s | PASS            |

The new staged target is
`E:\Perforce\Arif_MBResearch\Tools\.UEShedDataAuthoring-next3`. It found 556 DataTable exports and
opened `/Game/Demo/CombatCamera/DT_EnemyCameraConfig.DT_EnemyCameraConfig`. The extra descriptor is
`UDS_Readme_Entries`, whose class metadata is valid but whose payload is unsupported by the current
DataTable decoder. A separate `DT_ItemUI` package contains two DataTable exports; both are indexed,
but the current one-table-per-package authoring snapshot command cannot open either. An exhaustive
parallel check found 553 of 555 table packages currently openable. These entries remain visibly
partial rather than being silently omitted by metadata discovery.
