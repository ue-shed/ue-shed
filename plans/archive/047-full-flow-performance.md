# Full-flow performance investigation

Status: DONE — implemented and validated

Continue from `ee6d2b30e374fe05ecbea0f02e7886034572a446`. Speed is the priority; memory and storage
are measured guardrails. Preserve the user's unrelated Workbench icon changes. Private project
roots are read-only and never appear in committed code or evidence.

## Execution

1. Freeze the current reader and three-cohort evidence. Profile native header/query work and the
   actual Workbench project-opening path before selecting changes.
2. Explore header loading, parser work, temporary allocation, IO scheduling, Catalog reads/writes,
   query transport/validation, folding, startup, IPC, and rendering where measurements justify it.
3. Keep independent experiments and rejected variants. Compare fresh catalog scan, warm refresh,
   queries, input decode, full workload, sampled memory, and storage separately.
4. Validate parser/model and complete ordered query parity, malformed inputs, cancellation,
   recovery, relevant TypeScript/UI behavior, and native/WASM/platform checks for retained changes.
5. Record final results and remaining ideas with their measured cost or missing evidence. Stop
   when the remaining plausible work lacks a demonstrated bottleneck or requires a substantially
   larger design change; do not ship complexity merely to exhaust a list.

Use focused checks during iteration and the applicable repository/IO/library gates at completion.
Do not run the full portable gate unless required by the repository instructions. Commit and push
only when requested. Progress updates do not end the ongoing investigation.

## Experiment ledger

- Baseline: current production dictionary transport, frozen validated pages, binary Catalog,
  parallel discovery, eight header workers. Baseline artifacts and timing blocks are preserved in
  ignored `test-results/full-flow-2026-09-06/`.
- Native header profile: filesystem open/signature work dominates worker time; summary decoding
  happens twice per package. Sixteen header workers improved fresh large scans; thirty-two regressed.
- Parser: borrow unnumbered names during path construction; sampled replay improved with identical
  model fingerprints. Numbered/Unicode names and invalid-index diagnostics are covered.
- Dictionary validation: first compact-domain schema variant regressed; narrower reference
  validation improved. Domain bounds, invalid references, immutable reuse, and original page parity
  are covered.
- Queries: bounded flat posting union improves dense-name probes; grouped page-local header reads
  improved native probes and the full query workload. Streaming integrity checks reduce temporary
  memory and improved isolated paired status opens (118 ms to 111 ms).
- Refresh: borrow comparison keys, replace membership trees with hash lookups, and sort staging
  observations once. A final sorted merge supersedes the hash lookups: 2.80 s fresh, 0.54 s warm.
  An exact-root path shortcut showed no improvement and was removed. A sidecar-only
  deletion must publish its reduced inventory; the no-op predicate now checks inventory size.
- Workbench: home loaded four complete candidate corpora only to count them. New headless v1.4
  aggregate operation counts the union of bounded filters, without hydrating headers. First large
  cached-startup block improved from 1.41 s to 0.76 s. Preserve the first fresh-startup outlier.
- Renderer: defer 13 routes and use existing/new client-only extension entry points. Initial
  JavaScript fell from 1.99 MB to 0.70 MB; six-run fixture comparison improved fresh/cached project
  presentation by approximately 11%. All 13 routes and return-home navigation passed in Electron.
- Final conformance: Windows/Linux native oracle and process tests, parser/inspection/WASM and IO
  gates, focused TypeScript/Workbench tests, and precommit gate pass. All three cohorts have
  complete ordered-query/count parity and byte-identical physical snapshots. Packed native npm
  artifact works offline with an empty PATH. All 13 lazy routes work in real Electron.
- Final large baseline → retained: fresh 3.60 → 2.80 s, warm 708 → 537 ms, queries 474 → 447 ms;
  input decode 167 → 178 ms (slower in the final block). Cached Electron startup 1.35 → 0.67 s.
- Memory remains bounded; large native fresh peak falls, Node peak increases, and storage is
  unchanged. One Electron timing block exhausted scratch disk space; caches were cleared and the
  entire block repeated. Interrupted samples remain separate in evidence.
- Remaining filesystem journals, parser checkpoints, direct packed transport, and incremental
  physical persistence require larger contracts or a demonstrated bottleneck. No speculative
  implementation retained. See [report](../../docs/research/full-flow-2026-09-06.md) and its raw JSON.
