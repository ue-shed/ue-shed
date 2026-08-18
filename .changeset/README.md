# Changesets

Run `pnpm changeset` with the change that affects a public package. Select the packages whose
consumer-facing behavior changed and describe their direct impact. Through `1.0.0`, every public
package belongs to one fixed suite train, so Changesets aligns the entire public set to the highest
requested SemVer impact even when some packages have no direct change.

Private applications, extensions, examples, and tooling do not receive changesets.
