# Project Index query transport — 2026-09-06

The production process adapter now requests page-local string dictionaries and expands them into
the existing public query results. Validated results are deeply frozen, allowing the same page to
cross the adapter and public helper without a second traversal of every name. On this machine,
large warm queries improve 21%, medium queries improve 16%, and large query traffic falls 62%.

## Baseline and method

The baseline is commit `07e73c5039d3143d7bad6a5bcae870e56773ac6f`, including the preceding parser,
header-worker, and parallel-discovery passes. The frozen executable is 4,821,504 bytes, SHA-256
`354ef146283554aaab81089559f70bb342cf06fbe3a1ef3189d55635213c77f5`.
The final executable is 4,890,112 bytes, SHA-256
`6c13d2b3110a83747bf408973b6c95c9a8168596b3ac7fc6702fa9c49eedb5f1`.

The maintained Workbench project-index benchmark exercises the headless public library flow.
Private project roots remain read-only. Fresh means an empty Catalog; the OS filesystem cache is
not flushed. Windows x64, Ryzen 9 7950X, 32 logical CPUs, 64 GiB RAM, Rust 1.94.0, Node 26.5.0.
The report date is local; raw evidence retains its original UTC timestamps.

Small and medium have three timed samples per state and variant. Large has six, with its final
baseline confirmation run after the optimized block. Each warm block has one untimed warmup.
Timing blocks run serially without compilation or tests. The confirmation restores the baseline's
five changed runtime modules from Git into disposable build artifacts, then restores the final
artifacts; it therefore measures the original TypeScript adapter as well as the original native
reader. Artifact hashes, raw samples, source hashes, and intermediate variants are retained in
[the JSON evidence](query-transport-2026-09-06.json). Scratch artifacts and logs live under ignored
`test-results/query-transport-2026-09-06/`.

## Separate before/after results

Times are milliseconds; baseline → final. Queries cover all five candidate routes with pagination.
Input decode is the targeted Enhanced Input step in fresh runs.

| Cohort        | Packages |  Fresh catalog scan |    Warm refresh |         Queries |    Input decode |
| ------------- | -------: | ------------------: | --------------: | --------------: | --------------: |
| Small fixture |       71 |       42.53 → 38.74 |   17.81 → 18.34 |   18.30 → 17.49 |   24.67 → 25.20 |
| Medium        |   10,128 |     251.07 → 248.10 |   40.21 → 43.21 |  106.33 → 89.39 |   56.43 → 56.40 |
| Large         |  199,539 | 3,769.48 → 3,690.99 | 751.01 → 730.35 | 634.47 → 498.37 | 187.21 → 167.27 |

This pass changes query transport and validation. Discovery, header parsing, refresh scheduling,
and input decoding code are unchanged; differences in those stages are not claimed as direct
optimizations. Large warm query samples are 614–670 ms before and 477–517 ms after. The fixture
does not show a meaningful speed change.

The full fresh workload is 148.30 → 151.78 ms, 495.67 → 405.43 ms, and 4,743.25 → 4,510.00 ms.
The full warm workload is 142.62 → 150.24 ms, 165.74 → 156.84 ms, and 1,492.16 → 1,295.97 ms.
These timers include startup, folding, and resource-sampler completion, so adding stage medians
does not reconstruct the totals. Electron rendering and selection-to-first-screen remain unmeasured.

| Cohort |    Warm protocol bytes | Largest warm frame bytes |         Cache MiB |
| ------ | ---------------------: | -----------------------: | ----------------: |
| Small  |        81,016 → 46,094 |          28,022 → 14,267 |     0.071 → 0.071 |
| Medium |  3,780,276 → 1,389,372 |      1,685,692 → 594,525 |     8.230 → 8.230 |
| Large  | 24,048,563 → 9,163,475 |      2,384,738 → 763,422 | 130.997 → 130.997 |

Protocol byte counts include the small refresh stream; the large workload still uses 18 query
pages and returns the same 14,927 headers. Storage is byte-for-byte unchanged.

| Cohort | Sampled native peak RSS MiB | Sampled Node peak RSS MiB |
| ------ | --------------------------: | ------------------------: |
| Small  |                Not captured |           144.06 → 144.17 |
| Medium |               62.51 → 50.50 |           196.83 → 176.64 |
| Large  |             404.15 → 398.56 |           336.25 → 252.40 |

Memory values are medians of sampled fresh-run peaks. Large maximum observations are 414.14 →
407.23 MiB native and 341.12 → 293.38 MiB Node. Medium native maxima are 73.38 → 68.79 MiB.
These are sampled working sets, not allocator accounting; the fixture native process is too brief
for reliable capture. No dependency or persisted Catalog format was added.

## Experiments and retained design

| Initial large three-sample blocks                     | Warm query median ms |
| ----------------------------------------------------- | -------------------: |
| Original adapter and ordinary pages                   |               625.50 |
| Dictionary only                                       |               601.87 |
| Dictionary plus synchronous domain decoder experiment |               587.19 |
| Dictionary plus reuse of frozen validated pages       |               490.18 |
| Ordinary pages plus reuse of frozen validated pages   |               519.26 |

Payload reduction alone gives a modest latency improvement. The larger gain is avoiding repeated
domain validation of an already validated page. The synchronous decoder experiment was not retained:
it did not demonstrate a separate compelling gain and still used the schema interpreter underneath.
The final confirmation uses both dictionary transport and frozen-page reuse.

Protocol v1.3 adds explicit `pageEncoding: "dictionary"` and a named dictionary-page result. Only
class and serialized-name strings are interned; paths and map items retain their original shapes.
Each page carries its own dictionary, capped at 131,072 strings. Existing bounds of 1,024 items
and 64 references per header field remain, and missing dictionary references fail before expansion.
The cumulative output budget remains enforced. Requests omitting the encoding receive ordinary
pages. Older workers reject the new request field and surface the existing typed incompatibility
error; consumers need a paired worker upgrade to use the new adapter.

Domain validation still enforces its tighter path, name, cursor, and array bounds. After validation,
the page, item list, items, and nested name arrays are frozen. A private WeakMap recognizes only
those validated results; it does not retain otherwise unreachable pages. Arbitrary frozen objects,
mutable inputs, and deserialized copies must run the schema. This makes reuse depend on established
validation and immutability, without unchecked casts or skipping an external boundary. Public
TypeScript result fields stay the same; consumers needing mutation must copy the readonly result.

## Validation

- `check:precommit` passes: formatting, lint, type checks, StyleX, architecture, and contracts.
- `uasset:check:io` passes, including native Clippy/tests, process tests, native/WASM fixture
  parity, compact projections, typed failures, and limits.
- Windows and Linux optional SQLite-oracle runs each pass 96 library tests and 15 process tests.
  The ignored crash-child helper is exercised by its parent test.
- Protocol and adapter tests cover the shared ordinary/dictionary fixtures, exact expansion,
  duplicate/order/Unicode preservation, empty arrays, invalid references, numeric/array bounds,
  wire normalization, domain limits, frozen-page provenance, and attempted mutation.
- Native process tests exercise ordinary and dictionary requests in one session, pagination,
  stale generations, and cumulative output limits. The real TypeScript process adapter also
  refreshes and queries the fixture successfully.
- All five complete ordered query routes match on all three cohorts after dictionary expansion.
  Entire physical Catalog snapshot hashes match on all three cohorts as well.

The full repository gate was not run. Hosted CI timings and macOS execution are not established
by these local Windows/WSL results. Remaining candidates include reducing native query hydration
allocations and measuring the actual Workbench presentation path.
