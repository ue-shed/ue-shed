# Map Review capture contract v1

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
no-selection, multiple-selection, or editor-unavailable failure. Candidate generation and approval
are deliberately outside this wire contract.
