# `@ue-shed/project-custodian`

Headless discovery, policy, sizing, and guarded cleanup for regeneratable Unreal project and engine
storage. Scans and plans are read-only. Mutation requires a durable proposal containing exact target
IDs, its generated approval phrase, a fresh disk revalidation, and a stopped Unreal Editor. Cleanup
moves targets to the operating system Trash/Recycle Bin by default; permanent deletion is explicit.

```ts
import { Custodian, CustodianNodeLive } from "@ue-shed/project-custodian";
import { Effect } from "effect";

const report = await Effect.runPromise(
	Effect.flatMap(Custodian, (custodian) => custodian.scan({ root: "D:/Unreal" })).pipe(
		Effect.provide(CustodianNodeLive)
	)
);
```

The scan root is explicit and depth-bounded. `Custodian.prepare` persists a proposal plus append-only
event log; `Custodian.execute` returns a per-target receipt and only acts on a proposal read back from
disk. `Custodian.cancel` stops before the next target. Browser-safe schemas are exported from
`@ue-shed/project-custodian/browser`.

The same lifecycle is available from the CLI:

```powershell
pnpm ue-shed custodian plan D:\Unreal --ignore-pressure
pnpm ue-shed custodian prepare D:\Unreal --ignore-pressure --target <target-id> --output .\custodian-review
pnpm ue-shed custodian apply .\custodian-review\<proposal>.json --approve "RECLAIM <proposal-id>"
```
