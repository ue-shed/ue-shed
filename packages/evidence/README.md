# `@ue-shed/evidence`

Portable local evidence primitives for UE Shed camera and scenario workflows: artifact identity,
typed manifests, hashes, provenance, and honest complete/partial outcomes. Domain packages
contribute portable evidence without inventing unrelated local paths.

This package does not own a centralized archive, downstream MB Map Observation contract,
automation schedule, studio retention policy, or cross-product search index. A downstream archive
references UE Shed manifests and hashes through its own schema.

Map Capture contributes the versioned `ue-shed-map-tile-pyramid` manifest through
`@ue-shed/cameras`. It records requested and snapped bounds, exact grid policy, capture/render
policy, hashes, provenance, and honest incomplete outcomes. Completed bundles are immutable local
evidence; partial and cancelled attempts remain quarantined outside completed-run discovery. A
future shared evidence catalog may index those manifests without changing their portable contract
or taking ownership of tile-grid policy.
