# `@ue-shed/niagara`

Headless Niagara preview capture and portable evidence publication.

The package launches the separately installed `UEShedNiagara` Editor commandlet through a
supervised Unreal process tree, validates its contained producer receipt and PNG frames, hashes the
artifacts, and atomically publishes an immutable Niagara Preview Run. It does not depend on
Workbench or modify the source Niagara System.

The default destination is `<project>/.ue-shed/niagara-preview`. Unreal stages only beneath
`<project>/Saved/UEShed/NiagaraPreviewStaging`; the caller's destination is never passed to Unreal.

Hosts that only need the schema-owned request, manifest, artifact, and failure contracts can import
the browser-safe `@ue-shed/niagara/browser` entry point without loading Node or Unreal adapters.

See [`docs/products/niagara-preview.md`](../../docs/products/niagara-preview.md) for the product
contract and current limitations.

`runNiagaraPreview({ onProgress, ...options })` accepts an Effect callback for optional producer
progress: initialization, compilation, camera fitting, frame capture, receipt writing and completion.
Progress carries run identity, frame counts, and elapsed milliseconds. It is optional telemetry;
completion/publication still requires a validated receipt and frame artifacts. Older producers can
omit progress. The CLI writes progress JSON lines to stderr and its final result to stdout.
