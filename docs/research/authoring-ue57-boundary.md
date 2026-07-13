# Unreal Engine 5.7 DataTable authoring boundary

This note records engine behavior verified against the stock Unreal Engine 5.7 source tree. It is an
implementation input, not a public protocol decision.

## Stock Remote Control

The stock Remote Control HTTP module provides:

- `/remote/info` for route discovery;
- `/remote/object/call` for reflected function calls;
- `/remote/object/property` and collection mutation routes for reflected properties;
- `/remote/object/describe` for object descriptions;
- `/remote/batch` for bundling HTTP operations.

Source: `Engine/Plugins/VirtualProduction/RemoteControl/Source/WebRemoteControl/Private/`
`WebRemoteControl.cpp`.

Remote Control validates reflected calls and separately gates console-command and Python execution.
The HTTP batch route is transport batching; it does not create an editor transaction or guarantee
domain rollback.

## Stock DataTable operations

`UDataTableFunctionLibrary` exposes reflected operations for row and column names, row existence,
column export, and row-structure lookup. In editor builds it additionally exposes JSON/CSV import and
export plus Add and Remove row operations.

Source: `Engine/Source/Runtime/Engine/Classes/Kismet/DataTableFunctionLibrary.h`.

These operations provide useful degraded behavior, but they do not form the complete product
contract:

- the generic row getter and row adder use custom thunks whose dynamic struct payload is awkward for
  a stable external wire contract;
- whole-table JSON export is useful for characterization but does not expose a complete, normalized
  field schema with editing metadata;
- there is no reflected Set Cell, Rename Row, or arbitrary Reorder Rows operation;
- import replaces broad table state and is too coarse for reviewed command dispatch;
- individual calls are not a bounded transactional authoring batch.

`FDataTableEditorUtils` has C++ editor helpers for Add, Remove, Rename, and Move row plus change
notifications. Source:
`Engine/Source/Editor/UnrealEd/Public/DataTableEditorUtils.h`. These helpers are implementation
building blocks for a companion plugin, not remotely callable product APIs.

## Transactions and saving

`FScopedTransaction` provides the editor transaction boundary needed to commit or cancel a batch.
Source: `Engine/Source/Editor/UnrealEd/Public/ScopedTransaction.h`.

The optional Editor Scripting Utilities plugin exposes asset listing, loading, and saving through
`UEditorAssetLibrary`. Source: `Engine/Plugins/Editor/EditorScriptingUtilities/Source/`
`EditorScriptingUtilities/Public/EditorAssetLibrary.h`.

Requiring that broad plugin merely to obtain reliable authoring discovery and Save would enlarge the
fixture and deployment contract. `UEShedAuthoring` can instead expose a narrow asset query and save
result with explicit capability and error semantics.

## Verified companion-plugin gaps

The complete authoring product needs a separately enabled editor capability for:

- deterministic DataTable discovery with asset and row-structure identities;
- normalized reflected schema and relevant metadata;
- typed snapshots that preserve unknown values;
- stable content fingerprints;
- typed cell and row mutation;
- rename and arbitrary reorder;
- bounded multi-command transactions with rollback;
- Composite parent inspection;
- explicit Save results for affected assets.

Stock operations can remain useful as degraded capabilities where their behavior is truthful. The
public library must not silently swap a precise companion operation for a lossy stock fallback.

## Fixture evidence

The generic fixture generator successfully exercised the following stock engine behavior:

- JSON import into native C++ row structs;
- scalar, enum, nested struct, `FText`, soft object reference, `FDataTableRowHandle`, array, set, map,
  and deliberately opaque structured values;
- stable row iteration order after save and reload;
- Composite parent ordering and later-parent override semantics;
- package creation, save, fresh-process reload, and row-structure identity.

The fixture intentionally does not define the external schema, snapshot, fingerprint, or command
wire formats. Those are the next architecture decisions.
