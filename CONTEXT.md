# UE Shed Domain Context

This glossary names durable concepts used across plans, decisions, public modules, and tests. It
describes product meaning, not a required implementation or storage schema.

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
