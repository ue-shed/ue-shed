# Changesets

Run `pnpm changeset` with the change that affects a public package. Select only packages whose
consumer-facing behavior changed; Changesets adds dependent package bumps when an exact internal
dependency moves out of range.

Private applications, extensions, examples, and tooling do not receive changesets.
