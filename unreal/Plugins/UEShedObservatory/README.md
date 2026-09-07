# UEShedObservatory

The separately enabled editor capability for bounded actor discovery, spatial snapshots, editor focus,
and demand-driven actor transform streaming.

## Remote Control surface

- `GetActorSnapshot` — bounded JSON snapshot of filtered world actors (compatibility/fallback path).
- `FocusActor` — select and frame an actor in the editor or PIE world.
- `StartActorObservation` — validate cadence (1–60 Hz), build a catalog with dense stream indices,
  return session metadata and pipe name, then begin transform sampling.
- `StopActorObservation` — idempotently stop sampling and the pipe writer.
- `SetActorObservationCadence` — retune an active stream without replacing its catalog, session, or
  named-pipe writer.
- `GetActorObservationStatus` — bounded counters and connection health without actor arrays.

## Transform stream

On Windows the producer connects as a named-pipe client to
`\\.\pipe\ue-shed-observatory-v1-<pid>` and emits USOT v1 binary packets documented in
`packages/protocol/contracts/observatory/v1/README.md`. Catalog bounds are computed once at catalog
creation or invalidation; transform samples call only validity checks and `GetActorTransform()`.
Sampling and packet encoding run on the editor game thread; a writer thread holds at most one latest
packet.

Non-Windows editors return `not_supported` with guidance to use bounded snapshot polling at ≤10 Hz.

Snapshots and discovery catalogs include optional full class path, authored GUID, folder, owning level and up to 256 actor tags with an explicit truncation flag. Metadata is sampled at discovery; refresh the catalog after edits. USOT transform packet layout and sampling work are unchanged.
