# UEShedObservatory

The separately enabled editor capability for bounded actor snapshots and focus. It reports stable
object paths, class, label, transform, bounds, map identity, world kind, and observation time through
validated JSON. Focus accepts editor and PIE actors; PIE actors select their editor counterpart when
one exists and still move the level viewport when they are runtime-only. It does not mirror arbitrary
UObject properties or retain history.
