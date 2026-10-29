---
"@ue-shed/cli": minor
---

Check a Perforce changelist's text without a workspace synced to it. `ue-shed loc gate --change <CL>`, `--shelved <CL>` and `--from <CL> --to <CL>` (a range of submitted changelists) read the files a change touches before the change and at it, and judge the change against each target's localization as the change found it; a warm check of a large UE 4.27 project's changelist takes 1.3–1.6 s. `ue-shed loc diff` lists the lines a change adds, removes, rekeys or edits and what it does to translations, without a verdict. Both print `--format json`, `text` or `markdown`. `ue-shed guide changelist-check` prints a guide for coding agents.

Breaking for scripts: every CLI failure now exits by its error's next step: `2` could not run, `3` may succeed if repeated (such as Perforce being unavailable), `4` an internal crash (formerly `1`, which now only ever means a failed check), `130` interrupted.
