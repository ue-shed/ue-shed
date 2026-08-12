# `@ue-shed/evidence`

Durable artifacts, metadata, provenance, logs, captures, and retention semantics shared by camera and
scenario workflows. Domain packages contribute typed evidence instead of inventing storage paths.

Map Capture contributes the versioned `ue-shed-map-tile-pyramid` manifest through
`@ue-shed/cameras`. It records requested and snapped bounds, exact grid policy, capture/render
policy, hashes, provenance, and honest incomplete outcomes. Completed bundles are immutable local
evidence; partial and cancelled attempts remain quarantined outside completed-run discovery. A
future shared evidence catalog may index those manifests without changing their portable contract
or taking ownership of tile-grid policy.
