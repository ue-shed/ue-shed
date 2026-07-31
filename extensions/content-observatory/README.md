# Content Observatory

The Workbench presentation extension for the Perforce-first Map History workflow. Its route is
called **World Log**: select one configured map, choose a bounded look-back window, and inspect
submitted actor changes alongside their changelist and package evidence.

Deep History is the default and reads the complete selected map scope. Fast History is explicit:
load the current saved actor list, choose one actor or exact actor class, and then read only the
proven package scope from Perforce. Fast results always explain that they do not claim complete map
or historical class coverage; a class target covers current members only.

Use `pnpm showcase:world-log-fast` for the dedicated recorded path that demonstrates selecting a
current actor class and reading its targeted history.

The extension receives a narrow browser client with `status`, `targets`, `start`, and `cancel` operations. It
has no filesystem, child-process, Perforce credential, or workspace authority. Workbench keeps the
configured project root in its main process, validates all IPC input/output, and owns the scoped
Effect fiber that reconstructs a historical map tree.

Unclassified package revisions are deliberately shown as warnings. A missing semantic event means
the current saved-world projection cannot explain the changed package bytes; it does not mean the
package did not change.

This package does not provide a Perforce server or a fixture depot. The portable package fixture
lives in [`fixtures/perforce-map-history`](../../fixtures/perforce-map-history); the disposable
`p4d` conformance lane remains separately gated.
