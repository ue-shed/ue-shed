# Provisioned camera contract v1

`EnsureProvisionedCameras` accepts this bounded JSON request through Remote Control. A provisioned
camera is a transient runtime realization, identified by a generated `ProvisionedCameraId`; it is
never a durable Map Review camera record.

Each request carries an explicit correlation to either a framing candidate or a durable Review View.
The compatibility decoder accepts the former candidate-only request shape for already-installed
clients, but new clients emit only `schemaVersion: 2` and the `correlation` union.

The editor returns the same correlation for every provisioned camera. Array index remains a live
frame transport position, never durable identity.
