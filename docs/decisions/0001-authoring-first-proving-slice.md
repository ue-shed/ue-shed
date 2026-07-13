# 0001: Use data authoring as the first proving domain

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

The original repository sequence used an actor observatory as the first domain built on the shared
Unreal connection spine. DataTable authoring is also a first-party product track and has a clearer set
of generic, externally observable behaviors that can be exercised against a small fixture.

The repository needs early evidence for fixture reproducibility, schema fidelity, headless access,
typed snapshots, transactional editor mutation, and Apply-versus-Save semantics. Authoring exercises
all of those boundaries without requiring the data-plane streaming decisions needed by observatory.

## Decision

Data authoring is the first proving domain. It will build only the narrow shared discovery,
connection, and capability substrate needed by a generic authoring flow. That substrate remains
domain-neutral and reusable by later products.

Delivery remains vertical:

1. A reproducible fixture and executable conformance contract.
2. Read-only discovery, schema, snapshots, CLI inspection, and a default host-neutral view.
3. A safe editing loop with staged commands, validation, transactional Apply, and separate Save.
4. Concurrent-change safety and richer field families.

The actor observatory remains the first data-plane proving domain and must use the same shared
connection and capability contracts.

## Consequences

- `UEShedCore` still owns generic identity and capability discovery.
- `UEShedAuthoring` may be implemented before `UEShedObservatory`, but only for authoring-specific
  operations missing from supported stock APIs.
- The authoring package and CLI must work without Workbench.
- Fixture and conformance work precedes public authoring API design so engine behavior, rather than a
  desktop architecture, informs the contract.
- Named-pipe streaming and actor lifecycle work are deferred; they are not replaced by an
  authoring-specific transport.
