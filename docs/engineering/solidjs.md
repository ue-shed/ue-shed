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
Peculiar Sheets `0.13.0` still declares exact rc.7 peers. The workspace and adoption template allow
only rc.9 as an additional peer version for that package; keep this exception bounded and rerun
the component suite and Data Authoring adoption gate when changing it. All consumers must resolve
the same Solid runtime, not a separate rc.7 copy for the spreadsheet.

The peer exception does not establish compiler/runtime compatibility. The `0.13.0` distribution
was compiled with rc.7. `patches/peculiar-sheets@0.13.0.patch` renames its 23 static delegated
handler assignments from `$$event` to `_$$event`, matching the rc.9 renderer's event key. The
installed patched distribution has no remaining `$$event` or `$$eventData` assignments.
Double-click handlers already use the compatible public `addEvent(node, name, handler, true)`
call; `true` still means delegated. All 35 template calls use the default HTML flag. The four
`addEvent` calls, seven `ref` calls, class helpers and delegated event names match the installed
rc.9 helpers; the distribution has no `spread` calls or `use:` directives. No additional
mechanical DOM-helper patch has been identified.

Inline editing still failed to mount in the Electron probe after the event patch. The grid's
direct guards are Sheet `readOnly` and column `editable`; no `canEdit` prop or edit-mode callback
is required. Live DT_Scalars supplies editable bool/int/float/name/string descriptors. Workbench
disables the Sheet without a session, during persistence, or for composite tables. An enabled
Count cell's `aria-readonly="false"` establishes that both direct guards permit editing.
The remaining failure has not been isolated to event delivery or edit-state/DOM mounting.
Isolated in-process probes of installed rc.9 development and production signals both propagated
`latest(editMode)` into a rectangle memo; production also propagated it without an explicit flush.
These probes do not verify the mounted spreadsheet. The Workbench inline-edit e2e
exercises the actual Count cell, editor input, commit and Session Review, without applying or saving
to Unreal. It attaches column/cell read-only attributes and delegated-handler presence to
distinguish event registration failures from edit-state/DOM mounting failures. Rendering and mouse
selection alone do not verify inline editing. A saved-only snapshot without schema descriptors
intentionally keeps fields read-only; it cannot exercise the enabled inline editor.

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
