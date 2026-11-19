# SolidJS

Use SolidJS for maintained first-party UI.

Solid is a view layer. Headless packages own domain state and changes.

The maintained UI uses Solid `2.0.3` with the matching `@solidjs/web` renderer. Import DOM rendering
and JSX types from `@solidjs/web` and use it as `jsxImportSource`. The workspace catalog pins the
stable `@solidjs/vite-plugin`, which uses Solid's native JSX compiler. Component tests use the
Solid 2 line of `@solidjs/testing-library`, currently `1.0.0-rc.2`.

The root workspace and the Data Authoring adoption consumer pin `@solidjs/signals` to the same
release as `solid-js` through an override. This keeps Peculiar Sheets' exact rc.9 peer from pulling
in a second signals runtime.

The workspace patches Solid Flow's JSX entry to set up node and edge effects in their component
bodies. Remove the patch when the published package includes the
[upstream ref fix](https://github.com/dsnchz/solid-flow/commit/9a392b0d9a).

Signal writes are batched until the next microtask. Pass new values directly to operations that
run in the same event handler, and publish retained route state as it changes rather than waiting
for disposal. Split effects into a tracked compute function and an imperative apply function.
Use `onSettled` for mount work and return cleanup from effects and settled callbacks. Ref callbacks
are unowned; register their lifetime cleanup during component setup.

Peculiar Sheets runs directly on Solid 2. Data Authoring mounts TanStack Charts through its
framework-neutral DOM host, with updates and disposal owned by the surrounding Solid 2 component.

Peculiar Sheets `0.15.0` is compiled for Solid `2.0.0-rc.9` and declares exact rc.9 peers for
`solid-js`, `@solidjs/web` and `@solidjs/signals`, so pnpm reports unmet runtime and renderer peers
on Solid 2.0.3. The grid and renderer both use `_$$<event>` as the delegated handler key. A
distribution built for another key renders correctly but silently drops keyboard, input, mouse and
context-menu events. When upgrading Solid, check that the renderer and grid still use the same key
and share one Solid runtime.

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

For refreshed query results, use Solid 2's functional `For` key, such as
`keyed={(row) => row.id}`, to preserve a row's owner and DOM while replacing its data. In this mode
the child receives item and index accessors; read the item with `row()` so text, attributes and
event handlers see the replacement value. Grouped paginated lists should publish a reload only
after restoring their previously loaded page count, so intermediate pages do not remove focused
rows or collapse the scroll range.

Test user behavior and reactive lifetimes. Cover duplicate subscriptions, stale updates, cleanup, and
teardown in a live app where unit tests are not enough.

The component test setup flushes Solid after synthetic `fireEvent` dispatches. Tests that directly
write signals or invoke a custom paint scheduler must also flush before synchronous DOM assertions.

See [StyleX](stylex.md) for styles and [Testing](testing.md) for test scope.
