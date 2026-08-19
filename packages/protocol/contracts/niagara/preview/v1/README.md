# Niagara preview contract v1

These JSON Schemas are the language-neutral authority shared by `UEShedNiagara` and
`@ue-shed/niagara`.

`request.schema.json` describes the one request accepted by the commandlet. It carries no output
path: Unreal stages only beneath `Saved/UEShed/NiagaraPreviewStaging/<run-id>`.

`receipt.schema.json` describes completed producer render truth. The headless host must validate
identity, containment, frame order, byte limits, and PNG dimensions rather than trusting the
receipt. `manifest.schema.json` describes the immutable host-published run with per-frame hashes.

The alpha policy converts Unreal scene opacity to straight alpha and derives coverage from emissive
brightness for additive particles. Timing is deterministic within the requested engine execution;
the contract does not claim cross-GPU pixel identity.

Change this contract in authority order: JSON Schema and fixtures, conformant Effect codecs,
`UEShedNiagara`, then consumers.
