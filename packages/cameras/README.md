# `@ue-shed/cameras`

Headless camera observation and durable Map Review APIs. The package owns the versioned BGRA8 frame
decoder, bounded named-pipe server, latest-frame snapshots, subscriptions, host metrics, Remote
Control adapters, portable Review Set schemas, filesystem repository, and Capture Run orchestrator.
Electron is only one consumer; Workbench UI is never required.

```sh
npm install --save-exact @ue-shed/cameras @ue-shed/unreal-connection @ue-shed/protocol
```

Node.js 22.14 or newer is required. Stable entry points:

```ts
import {
	ReviewCapture,
	ReviewRepository,
	decodeReviewSet,
	generateFramingCandidates
} from "@ue-shed/cameras";
import { MapReviewResult } from "@ue-shed/cameras/review-contracts";
```

The live transport is deliberately disposable: it validates and resynchronizes the byte stream,
caps individual payloads, and retains at most one frame per camera. Scheduling and producer health
remain on the control plane. Durable review captures do not use this live buffer: the editor stages a
bounded one-shot PNG, then the host validates, hashes, and promotes it into an immutable local run.

Spatial authoring adds typed selection inspection, normalized subject bounds, modular arc/ring rig
generation, Context/Facade/Cardinal convenience presets, partial per-candidate overrides, transient
candidate previews, bounds-drift diagnostics, and explicit approval with recipe provenance. Counts
are positive integers without a Workbench-owned product cap: the pure generator returns the exact
requested set and never silently truncates it. Recipe v2 stores the parameters and group+index
anchor used for a kept View; existing recipe v1 documents remain readable. The generation,
session-tuning, and approval APIs remain usable from the CLI without Workbench.

The durable loop supports approved perspective poses, actor-path subjects, Pure PNG captures, honest
per-view failures, and atomic run publication. Review Sets normally live in
`.ue-shed/review/sets`; generated runs live in `.ue-shed/review/runs` and remain local by default.
The language-neutral editor wire contract is under
`packages/protocol/contracts/cameras/review/v1`. Keep it green with
`pnpm --filter @ue-shed/cameras contract:check`.

This package does not depend on `@ue-shed/observatory` or `@ue-shed/observability`. World Scout's
USOT transform wire contract ships in `@ue-shed/protocol`; the Observatory host package remains a
separate later public surface.

Generic Map Capture adds an external `Map Capture Plan`, exact tile-pyramid math and selection,
bounded orthographic editor capture, and immutable hashed manifests without changing Map Review's
`CaptureProfile` or perspective wire contract. Its language-neutral v1 contracts live under
`packages/protocol/contracts/cameras/map-tile/v1`. Completed runs live under
`.ue-shed/map-capture/runs`; Workbench-authored plans default to
`.ue-shed/map-capture/plans`; Unreal staging is accepted only from
`Saved/UEShed/MapTileStaging`. Plans independently control fog and volumetric fog and can retain
natural Unreal LOD behavior or provide one scene-capture LOD distance scale per zoom level. Capture
Z is placement only and never selects an LOD.

```sh
ue-shed map-capture plan validate <project-root> <plan.json>
ue-shed map-capture inspect <project-root> <plan.json>
ue-shed map-capture run <project-root> <plan.json> <endpoint>
ue-shed map-capture run <project-root> <plan.json> <endpoint> --open-map
ue-shed map-capture run <project-root> <plan.json> <endpoint> --level 2 --level 3
ue-shed map-capture run <project-root> <plan.json> <endpoint> --tiles tile-keys.json
ue-shed map-capture runs <project-root> <plan-id>
```

Level/tile subsets are recovery or test attempts and are quarantined as partial; only an exhaustive
all-level run can be atomically published as complete. Map switching is a separate Core capability:

```sh
ue-shed editor world open <endpoint> /Game/Maps/Target
```

It refuses active PIE, missing maps, and dirty world packages instead of saving or discarding work.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
