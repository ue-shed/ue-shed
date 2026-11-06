# Parameterless service operations

The next source release exposes parameterless service operations as reusable Effect or Stream
properties. Parameterful operations remain functions. For example, execute `yield* ids.generate`
instead of `yield* ids.generate()`, and read `workspace.progressChanges` instead of calling it.
The declaration of each owning service is authoritative.

An operation property is a description of work, not its result. Running it twice must perform the
operation twice. ID generation uses `Effect.sync(makeId)`; it must never be replaced by
`Effect.succeed(makeId())`. Reads of mutable state stay inside the operation, and acquisition still
requires its original scope and services. Stream subscriptions acquire their own subscriber per
execution. Named spans enclose each execution, including failures and cancellation.

Host implementations should move execution into `Effect.sync`, `Effect.gen`, or an appropriate
resource constructor, and attach the existing operation name with `Effect.withSpan`. Use
`Effect.suspend` where constructing the next effect itself reads dynamic state or selects work.
Do not eagerly generate identities, acquire resources, capture a selected project, or cache results
as part of this migration. Callback boundaries that require a function still receive a callback,
for example `Effect.addFinalizer(() => session.discard)`.

The repository audit covers public service interfaces, live and test implementations, CLI workflows,
Workbench main and renderer clients, extensions, examples, release/adoption scripts and offline
consumer conformance. In particular, Game Text workspace hosts must supply effect properties for
their selected project's parameterless reads and refresh, and callers execute its parameterless
workspace operations as properties. Hosts on published 0.26.0 retain its callable declarations
until the suite is released and installed together. Do not assert compatibility with the new
source or change a consumer's dependency pin to an unpublished build.

The source change requires a coordinated minor release. Request/result schemas, native messages,
native stored records and parameterful transport dispatch shapes stay independent of the local service
operation representation. A host's checked dispatcher must adapt a no-argument handler to execute
the effect property, while keeping the dispatcher's external calling convention.

Workspace reads retain their selected-project lifecycle guard. Progress, target listing and quality
rule reads retire a previous project's retained model before running after a selection change,
just as parameterful reads do; changing a callback to an effect property must preserve this step.

The viewer read ports additionally preserve their host error channel through type parameters.
Use `AssetInspectionReadEffect<MyError>` and the corresponding generic viewer/search props when
annotating a fallible host implementation. Unannotated JSX consumers infer the error type. Their
transport-failure UI, owner scope and cancellation behavior stay the same; parameterization does
not convert expected failures to defects or erase known errors into an unknown channel.

Game Text host ports now fail with the exported `GameTextWorkspaceHostFailure` tagged error.
Construct it with the existing message, recovery, retry guidance and optional code. When adapting
an existing host failure, retain that original value as `cause`. This replaces the former untagged
structural interface so workspace handlers can catch host failures explicitly without catching
defects, interruption or unrelated future error types. Hosts on published 0.26.0 keep its existing
structural contract until they adopt the coordinated source release.

TypeScript-owned measurement/cache metadata now rejects non-finite values, including JSON
numeric overflow such as `1e999`. Localization import rejects non-finite memory budgets through
its existing invalid-input error. Finite fractional scales and studio-owned thresholds retain their
meaning; these checks impose no new policy cap. Native schema ownership and wire representations
are unchanged.

Archive verification, extraction and compiled-plugin archive writing propagate fiber cancellation
to their foreign IO signal and wait for its pending close before releasing staging resources.
Caller-provided cancellation signals remain supported. Benchmark Effect measurements now run
inside their caller's context and scope, with their sampling timers released on every exit.

Saved map projection is a separate boundary: see [Saved map keys](saved-map-key-projection.md).
