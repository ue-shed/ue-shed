# 2026-07-17: clean-room Data Authoring agent adoption evaluation

Status: complete as a UI-transplantation evaluation; superseded as evidence of functional host
adoption. Source commit under evaluation:
`245d7e62baf8af33d1b6f8bc29cd41183fa74f06`.

## Question

Can a fresh coding agent transplant and build the Data Authoring browser slice in an empty project
using only the restricted adoption kit, without inspecting or copying Workbench?

This evaluation complements the deterministic conformance gate. Both prove the declared browser copy
closure builds; neither runs `ShedHostLive`, discovers a project catalog, opens a real saved table, or
connects to Unreal. The original report used “adoption” too broadly. These results measure UI source
and toolchain portability only.

## Method

Each agent received the same empty target, restricted source kit, prompt, source commit, and
acceptance criteria. The source kit contained only `ADOPTING.md`, the manifest, consumer template,
and declared kernel/owned closure. Targets and transcripts remain under ignored
`test-results/data-authoring-agent-eval/`.

The evaluator independently checked:

- all declared files were present;
- Workbench, Electron, and `window.ueShed` authority did not leak into production sources;
- the source commit was recorded in provenance;
- the source kit and UE Shed repository were unchanged;
- offline install and production build passed;
- `stylex.css` was non-empty and contained the adopter-owned `#ff6b6b` accent.

The three built applications were also served and inspected in a browser at desktop and 390 px
viewports. Reload behavior was exercised and browser console output was checked.

## Results

| Agent                       | Requested model        | Agent duration | Structural result | Independent result |
| --------------------------- | ---------------------- | -------------: | ----------------- | ------------------ |
| Cursor `2026.07.09-a3815c0` | `cursor-grok-4.5-high` |        102.7 s | PASS              | PASS               |
| Claude Code `2.1.211`       | `claude-sonnet-5`      |        400.4 s | PASS              | PASS               |
| OpenCode `1.18.2`           | `opencode-go/glm-5.2`  |        535.7 s | PASS              | PASS               |

All agents copied the 48 expected template/manifest files without omissions. Cursor and OpenCode
modified only the two requested owned theme files and added the report, provenance, and lockfile.
Claude made the same theme edits, added root convenience scripts and `.gitignore`, and preserved all
kernel files byte-for-byte.

All three applications rendered the same browser state with no runtime console errors. The route's
reload action completed. Production StyleX output was 13,977 bytes and contained the divergent
accent twice.

## Where agents tripped

### Cursor / Grok

Cursor was the cleanest and fastest run. It copied the declared closure directly, built without
retries, and noticed that theme divergence was incomplete. Its report did not preserve exact copy
and verification commands, and it had to infer that both the default token and applied theme
override required editing.

### Claude / Sonnet

Claude initially copied five `src` directories as `src/src`. Its first repair command was denied by
the CLI permission policy; it recovered and produced a correct target. The report later described
this as requiring no workaround, which understates the failure. Claude also treated the manifest's
`consumerTemplate` and the prompt-supplied source commit as if they were undeclared inputs.

Claude took 83 turns, produced 30,275 output tokens, and cost approximately USD 1.90. Its extra root
scripts and `.gitignore` were useful and should be promoted into the maintained template rather than
reinvented by adopters.

### OpenCode / GLM

The first OpenCode attempt could read the kit but its first write was auto-rejected as an external
directory operation. The successful run required an ephemeral `external_directory` permission
override. This is an orchestration requirement, not an adoption-source failure.

GLM inspected nearly every copied source and test file before copying, retried several truncated or
incorrect searches, and spent roughly 89,000 tokens. Its report claimed the old accent was absent
even though it had found residual hardcoded green rules, and it described a manual approximation of
the source-repository conformance command as equivalent to running the gate.

Most seriously, OpenCode ran `pnpm config list`, which captured a live npm registry token in its
transcript. The local log was redacted and the evaluation session was deleted, but the token must be
rotated because local cleanup cannot undo provider exposure. A separate resolved-config diagnostic
also printed a configured provider API key; that credential must also be rotated.

## Cross-cutting adoption defects

1. **Theme divergence is not coherent.** `tokens.stylex.ts` and the applied
   `themes.stylex.ts` both define the accent, while `authoring-route.tsx` retains hardcoded green
   rules. The browser visibly showed a pink primary action beside green secondary accents.
2. **Copy semantics are underspecified.** The guide does not explicitly say that directory entries
   copy to the same relative target path and that the consumer template's _contents_ land at the
   target root. Claude's `src/src` error is direct evidence.
3. **The browser closure includes source-side tests.** Whole `src` entries bring Node/Vitest test
   files whose dependencies and fixtures are not included. Production builds remain browser-safe
   because those files are outside the reachable application graph, but every agent had to explain
   the discrepancy.
4. **Provenance is required but not specified.** Agents invented different JSON shapes. The kit
   should include a schema/template, source commit, and manifest snapshot.
5. **Target-side verification is missing.** The manifest names a command runnable only in UE Shed.
   Adopters manually approximated it. The kit needs a portable target command covering typecheck,
   build, authority scan, CSS extraction, and optional expected-token divergence.
6. **Cosmetic Workbench coupling remains.** Owned route recovery text says “Restart Workbench,” and
   theme/font identifiers retain Workbench names. These are not authority leaks, but they undermine
   the claim that the slice is ready to feel native in another host.
7. **Narrow-host behavior is poor.** At 390 px the desktop two-column layout remains side by side,
   leaving an extremely narrow detail pane. Either publish a supported minimum width or add a real
   responsive layout.
8. **Agent harnesses must be credential-hostile.** Runs need an empty npm user config, cleared token
   environment variables, explicit prohibitions on configuration inspection, output redaction and
   secret scanning, preserved failed-attempt evidence, and separate agent-versus-verifier timing.

## Decision

The narrower UI-transplantation hypothesis passed across three independent agent/model stacks. The
central functional-adoption hypothesis remains untested because every generated host uses the
template's in-memory `AuthoringClientShape`. Before claiming host onboarding, the kit and harness must
run the real host authority and prove catalog discovery plus table opening in a foreign target. Live
Unreal mutation remains a further capability on top of that saved-project baseline.

## Remediation and Cursor regression

Completed 2026-07-17 against source commit
`e77233dee60cac5980bc38ac6d16219a7ef0526e`.

The kit now provides:

- unambiguous materialization from template contents and identical relative manifest paths;
- a production-only 29-entry closure without source-side tests;
- a versioned provenance schema, template, manifest snapshot, and generated record;
- root build/verify scripts plus a portable target verifier;
- a report template that requires exact commands, results, ambiguities, workarounds, and undeclared
  inputs;
- one applied `colorAccent` ownership edit, with route accents consuming the semantic token;
- product-level theme/host wording and a narrow-host responsive layout;
- credential-hostile agent environment defaults, secret detection/redaction, timestamped transcript
  preservation, and separate agent/verifier timing.

Cursor `2026.07.09-a3815c0` with `cursor-grok-4.5-high` passed the fresh regression in 63.7 seconds;
independent verification took 4.0 seconds, for 67.8 seconds total. It used the materializer, changed
exactly one line in `themes.stylex.ts`, installed offline, and ran the exact portable verifier. It
reported no ambiguity, workaround, or undeclared input. Outside the generated lockfile, report,
provenance, and required theme edit, the target was byte-for-byte identical to a freshly materialized
baseline. The kit and repository remained unchanged, and no secret-shaped output was detected.

The kit-polish gate is therefore complete. The next experiment may use one representative real
project to evaluate coexistence with its existing package, build, styling, and host conventions.
