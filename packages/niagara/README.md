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
