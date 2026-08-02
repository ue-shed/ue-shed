# UAsset IO protocol v1

The checked-in JSON Schemas in this directory are the language-neutral authority for the UAsset
process seam. A caller writes one request to the uasset protocol command's stdin. The command writes
one NDJSON event stream to stdout.

Version 1 carries the complete request envelope, stream-control events, and typed result frames.
Every frame carries the same contract, requestId, and sequence. A supported request begins with
accepted and ends with exactly one terminal event. Sequence strictly increases; completed, failed,
and rejected are terminal. An explicitly supplied empty paths array means zero work and must not
select a project root.

Result frames use an explicit result kind. Generic inspection, authoring, scan, compact text,
compact texture, and saved-world values each have a named schema; there is no untyped result field.
The shared inspection schemas are exported from `@ue-shed/protocol` so the Effect reader and the
Rust worker can converge on one wire shape.

Expected request or operation failures use rejected or failed and exit 0. Non-zero process exits are
reserved for failures that prevent the command from establishing or completing the protocol stream.
Existing human command exit behavior remains unchanged.

Change JSON Schema and fixtures first, keep Effect schemas conformant with
pnpm --filter @ue-shed/protocol contract:check, then add Rust conformance coverage.

The TypeScript and Rust sides both run the complete shared fixture set. TypeScript coverage is in
`packages/protocol/src/uasset-io.test.ts`; Rust coverage is `cargo test -p uasset-io protocol`.
Adding a result variant requires a valid fixture that both tests decode, plus an invalid fixture when
the boundary rule needs a rejection case.
