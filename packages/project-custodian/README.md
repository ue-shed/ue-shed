# `@ue-shed/project-custodian`

Read-only discovery, policy, sizing, and cleanup planning for regeneratable Unreal project and
engine storage. The package never deletes or moves a path.

```ts
import { Custodian, CustodianNodeLive } from "@ue-shed/project-custodian";
import { Effect } from "effect";

const report = await Effect.runPromise(
	Effect.flatMap(Custodian, (custodian) => custodian.scan({ root: "D:/Unreal" })).pipe(
		Effect.provide(CustodianNodeLive)
	)
);
```

The scan root is explicit and depth-bounded. Browser-safe schemas are exported from
`@ue-shed/project-custodian/browser`.
