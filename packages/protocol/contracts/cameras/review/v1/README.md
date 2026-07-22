# Map Review capture contract v1

The checked-in JSON Schemas in this directory are the language-neutral authority for the stable
editor wire surface shared by TypeScript and UEShedCameras: capture request/response and selection /
subject-inspection response. TypeScript Effect codecs in `@ue-shed/cameras` and the Unreal C++
companion must remain conformant with them.

Portable Review Set / Capture Run documents and Workbench IPC remain TypeScript-owned Effect schemas
in `@ue-shed/cameras`. They are deliberately outside this JSON authority while Map Review authoring
recovery, live preview, and World Scout streaming plans remain active.

The control-plane request asks a separately enabled editor capability to resolve one actor subject,
realize one approved perspective pose transiently, and write one Pure PNG into the project's bounded
review staging directory. The response reports the staged path, effective dimensions, resolved map
and subject, duration, and map-package dirty state before and after capture.

The staged file is not durable evidence. A trusted host validates that the path is beneath
`Saved/UEShed/ReviewStaging`, hashes and copies the PNG into an immutable Capture Run, then deletes the
staged file. The editor capability never accepts an arbitrary output path.

Requests and responses declare `ue-shed-review-capture` contract major version 1. Expected failures
are structured, include recovery guidance and retry safety, and never masquerade as captured images.

`selection-response.schema.json` defines the adjacent editor-only spatial-authoring observation. It
returns one selected actor's normalized bounds and optional active perspective viewport, or a typed
no-selection, multiple-selection, or editor-unavailable failure. The same schema file also documents
subject-inspection failures (`map_mismatch`, `subject_not_found`); TypeScript keeps ambient selection
and subject-inspection as separate Effect unions that both conform to this JSON envelope. Candidate
generation and approval are deliberately outside this wire contract.

Change a wire shape in this order:

1. Edit the authoritative JSON Schema and add or update language-neutral conformance fixtures.
2. Update the Effect runtime schema until `pnpm --filter @ue-shed/cameras contract:check` passes.
3. Update the UEShedCameras producer and run `pnpm check:unreal` (review lane) on a trusted UE 5.7
   runner with Remote Control connected.
4. Switch consumers only after both producers pass.

Do not generate these files from TypeScript. That would reverse the authority established by ADR 0002.
