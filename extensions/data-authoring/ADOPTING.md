# Adopt the Data Authoring slice

Use [`adoption.manifest.json`](adoption.manifest.json) as the executable source of truth. This guide
is addressed to the coding agent performing the adoption. It is deliberately complete: do not
inspect Workbench or infer missing copy behavior from the source repository.

## Materialize the standalone host

Start with an empty target directory. Run the kit's materializer, passing the exact 40-character UE
Shed source commit supplied with the kit:

```powershell
node <kit>/extensions/data-authoring/adoption/materialize.mjs `
  --target <empty-target> `
  --source-commit <source-commit>
```

The helper applies these otherwise easy-to-misread rules:

- the _contents_ of `consumerTemplate` land directly at the target root, so the result contains
  `app/`, `packages/`, `extensions/`, and `scripts/` rather than an extra `consumer/` directory;
- every `copy.kernel` and `copy.owned` entry lands at the identical relative path in the target;
- only the production closure is copied—source-side tests and their fixtures are intentionally not
  part of the adopted application;
- the manifest and provenance schema are snapshotted under `.ue-shed/data-authoring/`;
- `ue-shed-provenance.json` records the source commit and exact kernel/owned boundary.

Do not hand-copy files unless the materializer cannot run. If it cannot, preserve the exact error in
`ADOPTION-REPORT.md` before reproducing all five rules above manually.

## Ownership boundary

- Entries under `copy.kernel` are provenance-marked upstream code. Pull fixes deliberately and do
  not casually edit them.
- Entries under `copy.owned` are the consuming project's on-ramp. The route, primitives, and theme
  may be changed freely.
- Do not copy `apps/workbench`. It is an Electron showcase adapter, not an integration template.
- Do not add filesystem, process, Electron, raw Unreal, or `window.ueShed` authority to browser code.

## Wire and brand the host

The materialized template already provides the required baseline:

1. Vite runs Solid first and `@stylexjs/rollup-plugin` second.
2. StyleX uses runtime injection while serving and extracts `stylex.css` for production.
3. An in-memory `AuthoringClientShape` is passed to `AuthoringRoute` through
   `EffectRuntimeProvider`.
4. The product-level `ueShedDarkTheme` is applied at the host root.
5. Package scripts provide `pnpm build` and portable target-side verification.

To demonstrate adopter ownership, change only `colorAccent` in the applied theme at
`packages/ui-theme/src/themes.stylex.ts`. For the evaluation lane, set it to `#ff6b6b`. The route
uses the semantic accent token throughout; do not chase literal colors across route styles.

## Verify inside the target

Do not approximate the source-repository conformance command. From the materialized target run:

```powershell
pnpm install --offline --ignore-scripts --frozen-lockfile=false
pnpm verify -- --expected-accent=#ff6b6b
```

The portable verifier checks the declared closure and provenance, rejects source-side tests and
forbidden host authority, scans copied production inputs for credential-like content, builds the
application, requires non-empty extracted StyleX CSS, and proves the chosen accent reached that CSS.
The source repository retains `pnpm test:adoption:data-authoring` to test materialization itself.

Write `ADOPTION-REPORT.md` with the exact materialize, install, and verify commands; their results;
any ambiguity or workaround; and every undeclared input used. Do not inspect environment variables,
package-manager configuration, credentials, or agent configuration while troubleshooting.

Licensing remains a deliberate external-distribution gate. This manifest proves local/private
adoption mechanics; it does not publish packages or grant rights.
