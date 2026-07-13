# Observability

Use traces, metrics, and structured logs. Logs alone are not enough.

Instrument:

- discovery, connection, negotiation, and reconnects;
- Unreal calls and data streams;
- queue depth, drops, gaps, and recovery;
- authoring load, validation, Apply, and Save;
- actor collection cost and coverage;
- camera capture and frame delivery;
- scenario runs, divergence, and evidence.

Spans should include safe IDs, versions, duration, result, and retry count. Metrics should cover
latency, traffic, errors, saturation, and coverage.

Do not put secrets, full user data, large payloads, or unbounded IDs in telemetry labels.

Health is a public feature. `ue-shed doctor`, CLI errors, and Workbench diagnostics must use the same
service state. Observability tools must report their own gaps, drops, cost, and limits.
