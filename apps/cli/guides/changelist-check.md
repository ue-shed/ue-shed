# Checking a changelist's text

For a coding agent, or a script, asked to check what a Perforce changelist does to a project's
text and its translations. UE Shed only reads: it never edits a package, C++, INI or CSV file, and
it never writes to Perforce.

## Pick the targets

```sh
ue-shed loc targets <project-root>
```

Each localization target is checked on its own. Without `--target`, every target is checked and
one Unreal has never gathered is skipped; a target you name must have a manifest.

## Check the change

```sh
ue-shed loc gate <project-root> --change <CL>
ue-shed loc gate <project-root> --shelved <CL> --target <name>
ue-shed loc gate <project-root> --change <CL> --format markdown
```

- `--change` reads a submitted changelist, `--shelved` a shelved one, straight from Perforce: the
  files it touches before the change and at it, and each target's manifest and archives as the
  change found them. The workspace need not be synced to it.
- `--files <list-file>` checks listed files as they are on disk instead, one path per line. It
  judges every line in those files, so a problem a file already had counts too; a changelist
  check counts only what the change introduces.
- Only one of `--files`, `--change` and `--shelved` is taken.

Read the outcome from the exit code, never from the text:

- `0`: passed.
- `1`: failed. The output lists the failing lines and a way forward for each.
- `2`: not checked. The error's `code` and `recovery` say why; fix that and run it again.
- `3`: not checked, but the same command may succeed later (Perforce was unavailable).
- `4`: UE Shed crashed. Report it with the output.

The default output is JSON: `status` (`passed`, `failed` or, when it could not check,
`not_checked` with an `error`), and per target a count for each check and up to 200 findings with
their `check`, `severity`, key, text, file and `guidance`. Branch on `check` and `severity`;
`guidance` is for people. `--format text` prints a few lines for a log, and `--format markdown` a
summary for a build page or a review comment.

## What each failing check means

- `key_changed`: a line's key changed, and its earlier key has translations the new key lacks. The
  next gather drops them. Carry them with `loc run prepare --carry`, then `loc apply --sync`, or
  keep the earlier key in Unreal.
- `conflicting_source`: one key now has two texts, so Unreal ships one of them everywhere. Give
  one text its own key in Unreal.
- `translated_text_changed`: translated text changed; those languages show it untranslated until
  it is translated again. Expected for a real wording change; tell the people who translate.

Warnings (`not_gathered`, `unresolved_key`, `removed`, `text_changed`, `gathered_source`,
`partial_read`) do not fail by default. A project changes that with `--fail-on <check>` and
`--warn-on <check>`.

Fixes are made in Unreal or in the code by a person. Do not edit `.uasset` files, localization
archives or PO files to make a check pass.

## List the differences

```sh
ue-shed loc diff <project-root> --change <CL> --format text --limit 50
ue-shed loc diff <project-root> --shelved <CL> --target <name>
```

`loc diff` takes the same change flags and lists each line the change adds, removes, rekeys or
edits, with its place, and what it does to the target's translations, without a verdict. It exits
`0` whenever it could read the change.

## What a check does not see

- Reflected metadata (`DisplayName`, `ToolTip` and enum names) is not checked.
- Code and config text is read with the project's engine. When no engine is found, code files are
  reported as `gathered_source` instead; set `UE_SHED_ENGINE_VERSION` (`4.27`, `5.7` or `5.8`) or
  `UE_SHED_ENGINE_ROOT` to name one.
- String Table CSVs and wrapper macros come from the workspace on disk, not from the changelist.
- A package read only in part is checked for what was read and listed as `partial_read`.
