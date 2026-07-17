# Adopt the Data Authoring slice

Use [`adoption.manifest.json`](adoption.manifest.json) as the executable source of truth. This guide
is addressed to the coding agent performing the adoption. It is deliberately complete: do not
inspect Workbench or infer missing copy behavior from the source repository.

## First-pass fast path

After reading this guide and the manifest, take this path before inspecting generated implementation
files:

1. Run the declared materializer.
2. Change the applied theme's single `colorAccent` value.
3. Install offline and build the copied native reader.
4. Run the exact source and functional target verifiers against the consuming Unreal project.
5. Start the host and inspect the real project catalog in a browser.
6. Complete the generated adoption report.

Trust the materializer and verifier on the first pass. Do not enumerate the template, read the full
route, guess alternate host paths, or run Git commands unless one of those commands fails with a
specific diagnostic. If troubleshooting is required, inspect only the file named by that diagnostic.

## Materialize the standalone host

Start with an empty target directory. Run the kit's materializer, passing the exact 40-character UE
Shed source commit supplied with the kit:

```powershell
node <kit>/extensions/data-authoring/adoption/materialize.mjs `
  --target <empty-target> `
  --source-commit <source-commit> `
  --accent #ff6b6b
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
3. A browser `AuthoringClientShape` uses the SDK's schema-validated HTTP transport. The copied Node
   server runs `ShedHostLive`, saved-project discovery, sessions, and optional Unreal connectivity.
4. The product-level `ueShedDarkTheme` is applied at the host root.
5. Package scripts provide `pnpm build` and portable target-side verification.

To demonstrate adopter ownership, change only `colorAccent` in the applied theme at
`packages/ui-theme/src/themes.stylex.ts`. For the evaluation lane, set it to `#ff6b6b`. The route
uses the semantic accent token throughout; do not chase literal colors across route styles.

## Verify inside the target

Do not approximate the source-repository conformance command. From the materialized target run:

```powershell
pnpm install --offline --ignore-scripts --frozen-lockfile=false
pnpm build:reader
pnpm verify -- --expected-accent=#ff6b6b
pnpm verify:host -- --project=<unreal-project-root> `
  --reader=<target>/target/release/uasset.exe
```

The first portable verifier checks the declared closure and provenance, rejects source-side tests
and forbidden browser authority, scans copied production inputs for credential-like content, builds
the browser and server, requires non-empty extracted StyleX CSS, and proves the chosen accent reached
that CSS. The functional verifier starts the copied host, discovers the configured project's saved
DataTables, and opens one real snapshot through the same HTTP client boundary used by the browser.
It fails if the catalog is empty or the table cannot be decoded. The source repository retains
`pnpm test:adoption:data-authoring` to materialize a foreign target, build its copied Rust reader, and
prove all 12 fixture tables plus one opened snapshot.

The offline install is a fast path, not a requirement. pnpm stores can be drive- or
configuration-specific; if it reports `ERR_PNPM_NO_OFFLINE_TARBALL`, rerun the same command without
`--offline` and record that fallback. Use the pnpm version pinned by the materialized root package.

To inspect the configured project in a browser after verification:

```powershell
$env:UE_SHED_PROJECT_ROOT = "<unreal-project-root>"
$env:UE_SHED_UASSET_EXECUTABLE = "<target>/target/release/uasset.exe"
# Optional for live Apply and Save when the project has compatible UE Shed capabilities enabled:
$env:UE_SHED_REMOTE_CONTROL_ENDPOINT = "http://127.0.0.1:30001"
pnpm start
```

Open `http://127.0.0.1:4174`. Saved-project catalog discovery and inspection are read-only and do not
require the editor. Draft session files remain under the adopted target's `.ue-shed/` directory.
Apply and Save stay unavailable unless the configured editor negotiates the required capabilities.
Large projects perform a cold saved-package scan on first load. The catalog operation has its own
five-minute default budget; override it with `UE_SHED_UASSET_CATALOG_TIMEOUT` when storage requires
more time without weakening the 30-second limit for opening one selected asset.

Cold discovery reads package headers only and reports progress in the project-index panel. The host
persists a versioned signature index at `.ue-shed/catalog/index-v1.json`; subsequent starts validate
path, size, and modified time and reparse only changed assets. Removing that generated index forces
a complete header-only rebuild without touching Unreal project content.

Keep `ADOPTION-REPORT.md` under 500 words. Include the exact materialize, install, reader build, UI
verification, and functional host verification commands; discovered table count and opened object
path; their results; any ambiguity or workaround; and every undeclared input used. Do not inspect
environment variables, package-manager configuration, credentials, agent configuration, or the
parent Git worktree while troubleshooting.

Licensing remains a deliberate external-distribution gate. This manifest proves local/private
adoption mechanics; it does not publish packages or grant rights.
