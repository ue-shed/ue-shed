# Website and illustrated guides

The public site lives in `apps/site`. Its guides describe user workflows; `docs/products` remains
the authority for product contracts. Update the guide when a workflow changes and link to the
contract instead of copying its full specification into the website.

## Refresh the saved-workflow screenshots

From a source checkout with Node.js 26, pnpm 11, and Rust installed:

```powershell
pnpm site:refresh
```

This builds Workbench, runs the `site-saved` Playwright journey against the generic fixture,
exports its asserted chapters, and checks the production website at desktop and mobile widths.
The journey opens Data Authoring, switches to Charts, searches Game Text, compares config
platforms, and inspects the contribution ledger. It uses an isolated Electron profile and does
not launch Unreal. This website journey ignores inherited `UE_SHED_*` project and endpoint
overrides and reserves an offline endpoint so it cannot capture a different configured project.
Texture preview generation remains in the separate `saved-workflows` journey,
because that operation can need an Unreal commandlet.

The homepage and guide pages use the same capture keys in
`apps/site/src/showcase/media.ts`, so one export updates both. PNGs live in
`apps/site/public/media`. The manifest records the source journey, recording ID, commit, dirty
state, capture date, and SHA-256 digest. A source revision identifies provenance; it does not
claim that a screenshot is current merely because it exists.

Review the images before committing the PNGs and generated manifest together. Check that the
asserted state is useful, text is readable, and only generic fixture data appears. Do not publish
studio content, personal paths, or screenshots of unexpected error panels. The exporter never
deploys the website or updates visual baselines automatically.

## Individual operations

```powershell
# Reuse a current Workbench build during iteration.
pnpm showcase:record site-saved --no-build
pnpm site:media --journey site-saved

# Choose a specific reviewed recording. Other journeys stay unchanged.
pnpm site:media --bundle site-saved=<recording-id>

# Verify committed images without requiring local recording bundles.
pnpm site:media --check

# Build, validate, and exercise the website.
pnpm site:check
```

With no journey selection, `site:media` requires a complete recording for every export-plan
journey. A missing chapter, failed latest recording, invalid manifest, escaped path, or invalid
PNG fails before publication files are written. Explicit pins allow choosing an older reviewed
recording. Selecting one journey preserves the other journey's images and original provenance.
Do not hand-edit a capture or its digest to bypass a failed workflow.

Map Review remains an explicit live lane. Follow [the showcase setup](../showcase.md#demo-6-map-review),
record `pnpm showcase:record map-review`, then export `pnpm site:media --journey map-review`.
It requires a rendering fixture editor on the colorful Camera Lab map, `L_CameraLoad`. The
journey creates both Capture Runs itself and verifies switching between them, so an old local
capture cannot silently become the website baseline. The site displays the actual capture date.

## Continuous checks and review artifacts

The portable workflow's website job runs `site:check` on pull requests and `main`. It checks
manifest/image integrity, builds the production site (including StyleX extraction), and uses
Chromium to exercise direct guide URLs, navigation, image decoding, keyboard tabs, and narrow
layouts. It uploads full-page desktop and mobile captures and failure traces under
`website-evidence-<run-id>`. Locally, those artifacts are under `test-results/site`.

These are functional checks and visual review artifacts, not pixel-diff regression baselines.
They do not prove that Workbench screenshots are fresh after arbitrary application changes.
Run `site:refresh` in the same change when the illustrated workflows change, and review the
resulting image diff. Unreal-dependent capture remains a separate local run; ordinary website
CI needs neither Unreal nor a running Workbench.

## Add a workflow

1. Add actions and visible-state assertions to the recorder, then capture the successful state.
2. Add the chapter slug and stable image key to `scripts/site-media-model.ts`.
3. Export a passing recording, then reference that key in `apps/site/src/guides.ts` and, when
   useful, the homepage showcase tabs.
4. Add the guide URL to the browser test in `apps/workbench/e2e/site/site.e2e.ts`.
5. Run `pnpm site:check` and inspect its desktop/mobile captures.

Preview locally with `pnpm --filter @ue-shed/site dev`. Deployment remains the existing explicit
`pnpm --filter @ue-shed/site deploy` operation.
