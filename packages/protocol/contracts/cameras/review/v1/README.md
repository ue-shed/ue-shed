# Map Review capture contract v1

The checked-in JSON Schemas in this directory are the language-neutral authority for the stable
editor wire surface shared by TypeScript and UEShedCameras: capture request/response, optional
assessment capabilities, and selection / subject-inspection response. TypeScript Effect codecs in
`@ue-shed/cameras` and the Unreal C++ companion must remain conformant with them.

Portable Review Set / Capture Run documents and Workbench IPC remain TypeScript-owned Effect schemas
in `@ue-shed/cameras`. They are deliberately outside this JSON authority while Map Review authoring
recovery, live preview, and World Scout streaming plans remain active.

Minor versions 0–1 accept the original actor plus approved-world-pose request. Minor version 2 adds
actor or oriented-bounds subjects, world-fixed or actor-relative viewpoints, and a requested
visibility-assessment method. Minor version 3 keeps those inputs but makes the editor response a raw
visibility measurement: the plugin reports what it observed and does not assign a product-facing
`clear`, `partial`, or `blocked` classification. Version 2 responses remain readable with their
original engine-produced classification. Minor version 4 adds one optional Clear companion to the
same capture operation. Its request carries only an effective producer instruction (`isolate_target`
or bounded `hide_explicit` actor paths); consumer policy, thresholds, and presentation remain
outside the wire contract.

The editor resolves an actor-relative pose atomically from the actor's current transform. Its
response records the resolved target, exact effective world pose, projection, bounded visibility
measurement, staged Pure image, optional staged Clear companion, duration, and map-package dirty
state. The companion reports its explicit component-list intervention and restoration outcome; a
Clear failure retains Pure evidence as a typed partial result. Current Capture Runs preserve that raw
measurement. `@ue-shed/cameras` provides an optional pure classification helper only when a consumer
supplies its own thresholds; UE Shed does not prescribe defaults. Capture Run v1.2 classifications
remain readable after migration as explicitly legacy interpretation rather than current evidence.

For version 3 actor requests, `automatic` resolves to a bounded render-truthful depth comparison.
The editor makes one full-scene depth capture and one subject-only depth capture at no more than
320×180, then reports the fraction of subject-depth pixels that remain visible in the full scene.
The method records its version and limitations; translucent or otherwise non-depth-writing subjects
fail assessment instead of producing a fabricated percentage. Explicit `ray_samples` remains
available as a cheaper diagnostic because collision and rendered visibility can disagree.
Unprojectable or fully offscreen v1.3 requests also return `not_assessed`, with the projection
diagnosis preserved separately. Oriented-area requests return `not_assessed`; area contents are not
treated as blockers. The requested subject-mask method remains unsupported.

`assessment-capabilities.schema.json` describes an optional producer fact report. It records which
requested assessment methods are supported by this editor, their effective method/version, and the
maximum depth-comparison render size. It does not select a method, classify a measurement, or set
consumer visibility thresholds; callers may ignore it and use capture responses alone.

Staged files are not durable evidence. A trusted host validates that every path is beneath
`Saved/UEShed/ReviewStaging`, hashes and copies each PNG into an immutable Capture Run, then deletes
the staged files. The editor capability never accepts an arbitrary output path.

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
