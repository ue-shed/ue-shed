# SolidJS

Use SolidJS for maintained first-party UI.

Solid is a view layer. Headless packages own domain state and changes.

The maintained UI uses Solid `2.0.0-rc.9` with the matching `@solidjs/web` renderer. Import DOM
rendering and JSX types from `@solidjs/web`; use it as `jsxImportSource`. Keep the compiler and
Testing Library on their Solid 2 prerelease versions from the workspace lockfile.

The `vite-plugin-solid` compatibility package delegates to `@solidjs/vite-plugin`; the lockfile
uses `3.0.0-next.44` with the rc.9 compiler and Babel plugin. Solid's runtime is ESM-only as of
rc.8, supported by the repository's Node 26 baseline.

The rc.9 tarball's declaration entrypoint re-exports five internal symbols stripped from its
client declarations. `patches/solid-js@2.0.0-rc.9.patch` restores their declarations from the
[rc.9 source](https://github.com/solidjs/solid/tree/solid-js%402.0.0-rc.9/packages/solid/src/client),
without changing runtime code or disabling dependency type-checking. The adoption manifest copies
the same patch. Remove it once an upstream release provides consistent declarations.

Signal writes are batched until the next microtask. Pass new values directly to operations that
run in the same event handler, and publish retained route state as it changes rather than waiting
for disposal. Split effects into a tracked compute function and an imperative apply function.
Use `onSettled` for mount work and return cleanup from effects and settled callbacks. Ref callbacks
are unowned; register their lifetime cleanup during component setup.

Peculiar Sheets runs directly on Solid 2. Data Authoring mounts TanStack Charts through its
framework-neutral DOM host, with updates and disposal owned by the surrounding Solid 2 component.

Peculiar Sheets `0.15.0` is compiled for Solid `2.0.0-rc.9` and declares exact rc.9 peers for
`solid-js`, `@solidjs/web` and `@solidjs/signals`. The library's compiled output must match the
renderer. Solid's renderer looks up delegated event handlers under a key that changed between release
candidates: rc.7 used `$$<event>`, rc.9 uses `_$$<event>`. A distribution built for another rc
renders correctly but silently drops keyboard, input, mouse and context-menu events. Upgrade Solid
and Peculiar Sheets together, and keep every consumer on a single Solid runtime.

`extensions/data-authoring/src/peculiar-sheets-runtime.test.ts` guards this offline. It reads the
renderer's `EVENT_KEY` from the installed `@solidjs/web` and requires every delegated handler in
the installed Peculiar distribution to use it. It also requires the Workbench to resolve the same
renderer. The Workbench inline-edit e2e (`apps/workbench/e2e/data-authoring-inline-edit.e2e.ts`)
edits the DT_Scalars Count cell through the real editor and checks Session Review. Inline editing
needs a live editor session, so it runs only with `UE_SHED_UNREAL_INTEGRATION=1`. Rendering and
mouse selection alone do not prove inline editing works.

Data Authoring component tests cover row-header rendering, selection and the host's public
`SheetProps.onOperation` boundary. They pass synthetic physical/visual addresses, including paste
and sorted row identities, through the real grid and route callbacks. These tests do not prove
the vendor editor, clipboard or context menus work; those interactions require browser coverage.

## Rules

- Read state through public services and clear state unions.
- Do not copy folds, validation, or protocol state machines into components.
- Prefer signals, memos, and small effects.
- Keep one Effect-to-Solid adapter for service state. It must bind interruption and subscription
  cleanup to the Solid owner so teardown cannot leave fibers or listeners running.
- Preserve stable identity when updates arrive.
- Clean up subscriptions with the right owner.
- Show loading, stale, reconnecting, error, and unsupported states.
- Check Solid behavior instead of copying React habits.

Test user behavior and reactive lifetimes. Cover duplicate subscriptions, stale updates, cleanup, and
teardown in a live app where unit tests are not enough.

The component test setup flushes Solid after synthetic `fireEvent` dispatches. Tests that directly
write signals or invoke a custom paint scheduler must also flush before synchronous DOM assertions.

See [StyleX](stylex.md) for styles and [Testing](testing.md) for test scope.
