# UE Shed World

Editor-only world preparation for `@ue-shed/world` and other UE Shed plugins. Enable alongside
`UEShedCore`; Core advertises `world.preparation.v1` only when this module is loaded. Remote Control
calls `UUEShedWorldLibrary::ExecuteWorldPreparation`. Native callers use
`FUEShedWorldPreparation::Execute` on the editor game thread with the same validated JSON contract.

The manager owns per-lease actor-list loaders and Data Layer snapshots. It supports planning,
acquisition, polling/renewal, region replacement and release. It does not alter `Enable Streaming`,
load the entire world as a fallback, or save packages. Loading and unloading use stock editor APIs,
including their transaction-buffer and garbage-collection behavior.

See [the product contract](../../../docs/products/world-preparation.md) and
[wire authority](../../../packages/protocol/contracts/world/preparation/v1/).
