# `@ue-shed/observatory`

Actor discovery, stable identity, bounded snapshots and deltas, retained spatial projection, and
focus operations. The first implemented slice powers Map Review's Live World Scout through validated
Remote Control calls and a local binary transform stream.

```sh
npm install @ue-shed/observatory@0.1.0-rc.3 @ue-shed/unreal-connection@0.1.0-rc.3
```

Install the matching `UEShedObservatory` plugin from the same release manifest. The package is
headless: a host owns its own IPC/UI adaptation and no Workbench or extension UI is required.

## Live actor observation

`Observatory.observe(endpoint, options)` owns the full demand-driven observation lifecycle and
returns an Effect `Stream` of `WorldObservationState`:

```ts
Observatory.observe(endpoint, { cadenceHz: 30 }).pipe(
	Stream.runForEach((state) => Effect.sync(() => render(state)))
);
```

It negotiates `StartActorObservation` over Remote Control, opens a scoped named-pipe server for the
returned pipe name, installs the actor catalog, and applies decoded USOT v1 transform batches into
`WorldObservationState` (`connecting` → `live` → `stale` → …). Resets and session changes reacquire a
fresh catalog automatically; sustained rejection or negotiation failure surfaces a typed
`ActorObservationSessionError` or `ActorObservationRecoveryExhaustedError` after a bounded number of
recovery attempts. `StopActorObservation` is always called when the stream's scope closes.
`Observatory.setObservationCadence(endpoint, cadenceHz)` retunes a running producer without closing
that stream's named-pipe session.

When the connected editor cannot stream (`not_supported`, e.g. non-Windows), `observe` falls back to
bounded `GetActorSnapshot` polling at ≤10 Hz and emits `polling_fallback` states instead of failing.

`snapshot` and `focus` remain for one-shot CLI and compatibility use.

The lower-level `ActorFeed` service (`actorFeedLayer`, `acquireActorFeedScoped`) owns just the
named-pipe transport and incremental USOT decoding, with a bounded sliding `PubSub` so a slow
subscriber only ever sees the newest packet rather than an unbounded backlog.

## Performance evidence

```powershell
pnpm benchmark:observatory       # deterministic host decode/apply + Canvas paint
pnpm benchmark:observatory:live  # running fixture editor in PIE; host + Workbench IPC/Canvas
```

The live command defaults to `http://127.0.0.1:30001`; set `UE_SHED_REMOTE_CONTROL_ENDPOINT` to
override it. It validates `L_CameraLoad`, the three fixture class counts, and PIE before measuring
the Unreal producer, named-pipe host, and a real Electron Workbench World Scout presentation. The
Workbench phase must sustain at least 10 painted transform sequences per second.
