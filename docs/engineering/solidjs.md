# SolidJS

Use SolidJS for maintained first-party UI.

Solid is a view layer. Headless packages own domain state and changes.

The maintained UI uses Solid `2.0.0-rc.7` with the matching `@solidjs/web` renderer. Import DOM
rendering and JSX types from `@solidjs/web`; use it as `jsxImportSource`. Keep the compiler and
Testing Library on their Solid 2 prerelease versions from the workspace lockfile.

Signal writes are batched until the next microtask. Pass new values directly to operations that
run in the same event handler, and publish retained route state as it changes rather than waiting
for disposal. Split effects into a tracked compute function and an imperative apply function.
Use `onSettled` for mount work and return cleanup from effects and settled callbacks. Ref callbacks
are unowned; register their lifetime cleanup during component setup.

Peculiar Sheets runs directly on Solid 2. Data Authoring mounts TanStack Charts through its
framework-neutral DOM host, with updates and disposal owned by the surrounding Solid 2 component.

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
