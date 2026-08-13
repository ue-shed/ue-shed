# Provisioned camera contract v1

`EnsureProvisionedCameras` accepts this bounded JSON request through Remote Control. A provisioned
camera is a transient runtime realization, identified by a generated `ProvisionedCameraId`; it is
never a durable Map Review camera record.

Each request carries an expected map and an explicit correlation to a framing candidate, a durable
Review View, or a Map Capture Plan. A camera selects either perspective field of view or
orthographic width through a discriminated projection. The compatibility decoder accepts the
candidate-only and `schemaVersion: 2` perspective request shapes for already-installed clients, but
new clients emit only `schemaVersion: 3`.

The editor returns the same correlation for every provisioned camera. Array index remains a live
frame transport position, never durable identity.
