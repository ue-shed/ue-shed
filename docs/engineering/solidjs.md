# SolidJS

Use SolidJS for maintained first-party UI.

Solid is a view layer. Headless packages own domain state and changes.

## Rules

- Read state through public services and clear state unions.
- Do not copy folds, validation, or protocol state machines into components.
- Prefer signals, memos, and small effects.
- Keep one clear adapter from Effect services into Solid state.
- Preserve stable identity when updates arrive.
- Clean up subscriptions with the right owner.
- Show loading, stale, reconnecting, error, and unsupported states.
- Check Solid behavior instead of copying React habits.

Test user behavior and reactive lifetimes. Cover duplicate subscriptions, stale updates, cleanup, and
teardown in a live app where unit tests are not enough.

See [StyleX](stylex.md) for styles and [Testing](testing.md) for test scope.
