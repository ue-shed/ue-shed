# UE Shed Domain Context

This glossary names durable concepts used across plans, decisions, public modules, and tests. It
describes product meaning, not a required implementation or storage schema.

## Map capture

### Map Capture Plan

A portable, versioned definition outside an Unreal map that identifies a project and map, requested
world-space bounds, fixed tile pixel size, deterministic zoom rule, capture Z and orientation, and
optional Data Layer/render and publication policy. It is distinct from Map Review's Capture Profile:
a Capture Profile controls the rendering of a Review View, while a Map Capture Plan defines a stable
cartographic grid and its capture run. Neither requires a saved camera actor or capture volume.

### Tile Pyramid

A multiresolution, world-aligned set of square image tiles derived from one Map Capture Plan. Every
level uses the same snapped bounds and origin; level `z + 1` halves world-units-per-pixel, doubles
rows and columns, and gives every parent exactly four children. Capture Z keeps the orthographic
camera above geometry but does not determine detail. The neutral manifest versions grid orientation,
gutter/crop policy, addressing, artifact hashes, provenance, and completion state.

### Tile Key

The stable `(zoom, row, column)` address of one tile. In orientation v1, rows progress from world
max-X toward min-X and columns progress from world min-Y toward max-Y. A Tile Key is spatial
identity, not a filename; relative paths are deterministically derived from it.

## Saved-project indexing

### Project Index

A headless, read-only view of the saved packages currently present in one Unreal project. A Project
Index has an explicit project identity and generation, reports refresh lifecycle and coverage, and
answers bounded questions about maps and compact package-header evidence. It is usable through
public TypeScript modules and the CLI without Workbench.

The Project Index does not own domain interpretation such as Game Text grouping, texture-audit
rules, DataTable authoring, or Enhanced Input projection.

### Catalog

The private, disposable persistence used to implement a Project Index. The native `uasset-io`
implementation owns its file format, schema migrations, transactions, locking, and corruption
recovery. TypeScript chooses the cache root and user-facing refresh/rebuild policy but does not read
or write the Catalog's storage schema directly.

A Catalog is derived data. It never lives inside the Unreal project or source control and may be
quarantined and rebuilt without changing project content.

### Index Profile

A versioned set of package-header probes required by Project Index consumers. A profile identifies
the classes, class-name conventions, and serialized names needed to select bounded candidates. It
does not authorize storing complete property graphs or establish a universal asset schema.

Changing the profile invalidates affected header evidence without changing the underlying package
identity or signature meaning.

### Generation

An immutable identifier for one successfully committed Project Index state. A generation advances
only after a complete refresh transaction commits. Cancelled, failed, or partial enumeration cannot
delete unseen packages or publish a new generation. Queries may require an expected generation and
fail explicitly when it is stale.

## Downstream integration

### MB Map Observation

A studio-owned, immutable record that correlates one saved-world actor snapshot
with optional Map Capture and Map Review artifacts. Its contract, archive,
idempotency, scheduling, retention, studio actor classification, and product
queries belong to the downstream MB Map module in the Tools repository. The
headless producer and designer presentation belong to Electroswag.

UE Shed supplies generic SavedWorld, Map Capture, and Capture Run primitives;
it does not own or persist MB Map Observations. MB Map Observation is distinct
from optional Perforce-backed Map History and World Log, and from live
actor/camera observation in Observatory.

## Niagara preview

### Niagara Preview Run

An immutable, portable PNG frame sequence captured from one saved Niagara System through its Baker
camera and timing. A run records requested and effective settings, engine provenance, resolved
camera, alpha policy, per-frame timing and hashes, and an honest terminal outcome. It is external
evidence: it never modifies the Niagara System or claims pixel identity across different GPUs.

The Unreal producer stages render truth beneath the project Saved directory. A headless host
validates and atomically publishes the Niagara Preview Run; an HTML player, sprite sheet, or video
is a derived representation rather than the authoritative run.
