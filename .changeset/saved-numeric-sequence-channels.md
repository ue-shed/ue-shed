---
"@ue-shed/uasset-inspection-wasm": minor
"@ue-shed/uasset-win32-x64": minor
---

Decode saved GameplayTagContainer and common math properties through the shared native layouts,
and expose saved scalar float/double and 3D transform channels through Level Sequence schema 4.
Each `numeric_channels` entry keeps section-local frame keys, values, interpolation and tangent
modes, weighted tangents, nullable defaults, extrapolation, tick resolution and ShowCurve; indexed
paths such as `Translation[0]` preserve axis identity. Missing channels and unsupported sections
remain explicit coverage gaps. Consumers upgrading from schema 3 must accept the new track kinds
and required channel arrays.
