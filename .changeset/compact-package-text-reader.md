---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/game-text": minor
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
---

Add the opt-in uasset-io v1.8 package-text extraction operation and public reader stream.
Each decoded package carries occurrences, complete gap counts and at most three diagnostic
samples. Preserve the existing extraction stream and add a corpus adapter for package records.

Negotiate uasset-io v1.9 package flags and gatherable-text summary count/offset in saved headers and Project Index
header pages. Rebuild disposable Catalog caches for header profile 2. Candidate helpers use
Unreal's gather flag, non-empty summary and saved external-package relationships; the fixture
audit proves that TextProperty adds no candidates and every decoded occurrence is retained.

Add optional corpus coverage for `not_gatherable` packages and exclusion diagnostics, retained
in bounded localization status reports and Game Text coverage notes, with an optional excluded
count in validated query summaries. The signature-keyed shared
package-text layer and host migration remain separate work.
