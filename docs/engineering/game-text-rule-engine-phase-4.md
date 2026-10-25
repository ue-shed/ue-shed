# Game Text rule engine: Phase 4 specification

This is the Phase 4 specification for [Plan 059](../../plans/059-game-text-query-and-rule-engine.md). It builds on the [Phase 1](game-text-rule-engine.md), [Phase 2](game-text-rule-engine-phase-2.md) and [Phase 3](game-text-rule-engine-phase-3.md) specifications and on [ADR 0012](../decisions/0012-native-engine-boundary.md), whose topology, contract and encoding classes still hold. It decides the wire, the API and the module boundaries.

Behaviour is defined by today's code, cited as `file:line` under `packages/game-text/src/` (`gt/`), `packages/unreal-assets/src/` (`ua/`), `crates/game-text-index/src/` (`ix/`), `crates/uasset-io/src/` (`io/`) and `extensions/game-text/src/` (`ext/`). The [fixture](game-text-corpus.md) is the oracle. Line numbers drift; re-check a citation before implementing it.

## 1. Scope

| Part           | What changes                                                                                                                                             | §   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| The session    | The engine gets its own binary session, `uasset game-text-engine`. One process per host replaces the interactive and bulk lanes.                         | 2   |
| Frames         | Length-prefixed binary frames carry request IDs. JSON nested in strings goes.                                                                            | 3   |
| Requests       | Requests run concurrently on one reader, in two classes. They can be cancelled. A failed request doesn't end the session.                                | 4   |
| Column batches | Every bulk answer streams as relation-specific column batches that TypeScript reads through typed-array views. Temporary files and the 16 MiB spill go.  | 5   |
| Queries as IR  | A Browse query is a `where` expression in the rule IR plus a text search. Selecting a row is one request.                                                | 6   |
| Progress       | Evaluation, open and export report progress on their own stream. The 250 ms poll goes.                                                                   | 7   |
| Sinks          | The engine writes every CSV and JSON row, to a file or onto the stream. Exports and `loc check` stream; the TS CSV writers go.                           | 8   |
| Deletions      | The NDJSON engine path, `payload: String`, the `output` paths, the 50-row cap, the TS engine schemas, the TS reference oracles and the second TS reader. | 10  |

**Not in Phase 4:**

- Incremental findings (Phase 5).
- The index builder's client (`ua/game-text-index-client.ts`). It keeps NDJSON and its intermediate files; Phase 5 rewrites the build.
- Other `uasset-io` operations (catalogue, packages, scans). They keep NDJSON (decision 30).
- Batches in the renderer (decision 34).
- Recycling a session at a memory ceiling. The panic and process-death probes ADR 0012 asks for are in §11; recycling waits for a measured need.
- Electroswag (Phase 6).

## 2. The session

- **One subcommand.** `uasset game-text-engine` runs the engine session and nothing else. The `game_text_engine` operation leaves the `uasset-io` protocol (`io/protocol.rs:72-76`), with its minor-15/20 split (`ua/game-text-engine-client.ts:19-25`).
- **One process per host** (decision 31). Today each snapshot gets two processes, each with its own reader (`gt/index-query-native.ts:45-77`, `gt/native-query.ts:71-77,180-212`). Now one process holds every open reader, keyed by handle (`ix/engine.rs:314-317`). The cap rises from 8 per process to 32 per host, since one host pins every snapshot it reads, previous generations included. Request classes (§4) replace the lanes.
- **Handshake.** Unchanged in substance: one `capabilities` request per process compares `contractHash` (refused on mismatch) and `buildId` (logged) (`ua/game-text-engine-client.ts:128-175`). Nothing is validated after it (ADR 0012).
- **Readers are shared and immutable.** `open` returns a handle to an `Arc` reader. The session's map sits behind a lock taken only to insert, look up or remove. Per-reader caches (`ix/engine_rows.rs:127`, the atom cache) are concurrent maps: a request computes outside the lock and inserts its result, so two requests may compute the same atom once each and the first insert wins. Findings layers are immutable once built; `findings_accept` produces a new layer handle, as it does today.
- **Closing.** `close` waits for the handle's in-flight requests, or cancels them when sent with `cancel: true`. A scope that closes the model sends that.

## 3. Frames

Every message in both directions is one frame. All integers are little-endian.

| Bytes | Field     | Meaning                                                                     |
| ----: | --------- | --------------------------------------------------------------------------- |
|   0–3 | `length`  | Body bytes after this 12-byte header. At most 8 MiB.                        |
|     4 | `kind`    | See below.                                                                  |
|     5 | `flags`   | Bit 0: the request's last frame.                                            |
|   6–7 | reserved  | Zero.                                                                       |
|  8–11 | `request` | The host's request ID; 0 for session frames. A host never reuses a live ID. |

**Host to engine:**

- `request` (1): JSON with the generated request type.
- `cancel` (2): no body.
- `credit` (3): JSON `{ "frames": n }` (§4).

**Engine to host:**

- `part` (16): JSON. One answer part that isn't rows: counts, facets, groups, a line's detail, a reply to a small request.
- `batch` (17): binary, a column batch (§5).
- `text` (18): UTF-8 rows a sink encoded for the stream (§8).
- `progress` (19): JSON (§7).
- `end` (20): JSON `{ profile, summary? }`. The request finished; `summary` holds totals such as rows written.
- `error` (21): JSON `{ error, profile }`, the generated tagged error.
- `cancelled` (22): JSON `{ profile }`.

The numbers are the `kind` byte. `end`, `error` and `cancelled` are terminal and carry flag bit 0. JSON bodies are read with `JSON.parse` straight into the generated types, and in Rust through the WTF-8-aware reader, so lone surrogates and the rule IR travel inline with no string-in-string (ADR 0012, "The rule program").

- **TypeScript reads frames** from the pipe into one growable buffer and hands each body out as its own `ArrayBuffer`. That is one copy, and it is what makes `Float64Array` views over a batch aligned.
- **Rust writes frames** from one writer thread that owns stdout (§4).
- **No sequence numbers and no per-frame checks.** Today's stream checks (`ua/protocol-transport.ts:131-241`) go with the NDJSON path. A malformed frame is an engine defect: the host fails the session with a typed defect and restarts it.

## 4. Requests

- **Classes.**
    - **Interactive:** `capabilities`, `summary`, `query` without a sink, `line`, `rules_check`, `close`.
    - **Bulk:** `open`, `findings_evaluate`, `findings_accept`, and any request with a sink or one whose rows part asks for more than 500 rows.
    - The class is derived from the request, never chosen by the caller.
- **Threads.**
    - A reader thread decodes frames and dispatches.
    - Interactive requests run on a pool of 2 threads.
    - Bulk requests run at most 2 at a time on the shared rayon pool, whose size is the machine's cores minus the interactive threads. Further requests queue FIFO in their class.
    - A keystroke never waits behind an evaluation, and an evaluation can't take the cores a keystroke needs.
- **The writer.** One thread owns stdout and takes frames from per-request queues. It always sends a queued interactive frame before a bulk one, so a 4 MiB export batch delays a keystroke by at most one frame already on the pipe.
- **Flow control.**
    - A request may have at most 8 `batch` or `text` frames that the host hasn't acknowledged. The host returns a `credit` frame as it consumes them.
    - A slow consumer, such as `loc check` writing to a slow pipe, stalls only its own request, and the host's memory is bounded by 8 frames per stream.
    - `part`, `progress` and terminal frames are not counted.
- **Cancellation.**
    - **In the engine.** `cancel` sets the request's token. Every row walk checks it at least every 65,536 rows, and evaluation checks it between rules and between chunks (`ix/engine.rs:327,578` today checks once). The request then ends with `cancelled`. A request that already ended ignores it.
    - **In TypeScript.** Interrupting the Effect that owns a call sends `cancel` and waits up to 2 s for the terminal frame. Past that, the session is stuck: the host kills it and fails every in-flight request with `EngineUnavailable`.
    - **Superseded reads cancel.** Today an admitted read is shielded from UI interruption (`gt/native-query.ts:108-134`). Now a superseded keystroke's query is cancelled.
- **Failure.**
    - A panic in a request is caught at the request boundary and ends that request with a typed `internal` error. The session continues, because shared state is immutable or behind locks that don't poison.
    - Process death (abort, OOM, a damaged mapped file) fails every in-flight request with `EngineUnavailable` and invalidates the session's handles. The next call starts a session, repeats the handshake and reopens the readers it needs.
- **Timeouts.** The 50-minute per-request deadline (`ua/protocol-transport.ts:977-1017`) goes. A caller that wants a bound interrupts, which cancels.

## 5. Column batches

A `batch` body is a `u32` header length, a JSON header, zero padding to 8 bytes, then buffers at the offsets the header gives, each 8-aligned.

```jsonc
{
	"part": "units", // which part of the answer the batch belongs to
	"relation": "unit", // the relation the columns describe
	"rows": 4096,
	"columns": [
		{ "name": "id", "type": "str", "offset": 0, "missing": "never" },
		{ "name": "identity", "type": "json", "offset": 16384, "missing": "never" },
		{
			"name": "findings",
			"type": "strList",
			"offset": 32768,
			"values": 49160,
			"validity": 81920,
			"missing": "omit"
		}
	],
	"strings": { "entries": 9021, "offsets": 82432, "bytes": 118520, "loneSurrogates": 401160 }
}
```

- **Types.**
    - `u32`, `i32` and `f64` are plain arrays.
    - `bool` is a bitset.
    - `str` is a `u32` index into the batch's string table.
    - `json` is a string-table index whose entry is JSON text: an open-ended or nested value a host reads per row, such as a finding's evidence, a place's location or a line's cultures. It is parsed only when a row is read. Arrow's JSON extension type is the precedent; the rule that JSON never nests in a string (§3) is about the envelope, and a `json` cell is a typed column.
    - `u32List` and `strList` are `u32` offsets (rows + 1) over a values array.
    - `validity` is an optional bitset; absent means every row has a value. `missing` says what a row without one holds: `null`, or no key (`omit`).
    - Identity lanes are `u32`; no `u64` crosses.
- **Strings.** Each batch has its own table: `u32` offsets (entries + 1) over WTF-8 bytes, and a bitset of entries holding lone surrogates. A column's index refers to that table. A string a batch uses twice is stored once (decision 35).
- **Size.** A batch holds at most 4,096 rows or 4 MiB of buffers, whichever comes first. A rows part of at most 50 rows is one batch, sent as soon as it's filled. A row too large for one frame fails its request with `limit_exceeded`.
- **Columns.** A request's rows carry the columns it names, in the order it names them. That order is the key order of each row object on the host, so an object built from a batch matches the one the engine's own encoders write.
- **Children.** A list that can grow without bound is its own part, never a column: a unit's places, a line's places, a findings page's place sets. Each child row names its parent in a `parent` column: the parent's row number in its part, or a place set's ID. A parent batch is sent only after every child of its rows, so a host can attach children as each parent batch arrives. Bounded lists (cultures, a line's problems, a unit's review signals) stay columns.
- **Relations.** Each relation's columns are declared once in Rust (`ix/batch.rs`) and generated into TypeScript as `Relations`, with each column's type and `missing` rule.

    | Relation     | Rows                                                       | Replaces                                                                           |
    | ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
    | `unit`       | corpus units                                               | `corpus`, `export` and their files                                                 |
    | `place`      | a unit's occurrences, a line's places, a page's place sets | the occurrences inside those files; `findings_query`'s inline sets                 |
    | `package`    | package coverage                                           | `corpus_header`'s file and the corpus file's list                                  |
    | `diagnostic` | corpus diagnostics                                         | the same                                                                           |
    | `line`       | localization lines and the fields a line read names        | `localization_export`, `localization_corpus` and `localization_focus_export` files |
    | `finding`    | a findings page's findings, as `json`                      | `findings_query`'s inline array and its spill file                                 |
    | `group`      | aggregate rows, each key component as text                 | `aggregate`'s file                                                                 |

    Step 7's `query` and `line` requests read the same relations, with Browse's row columns added to `line`.

- **TypeScript reads batches through views.** `EngineBatch<R>` gives:
    - `numbers(name)`, a typed-array view of a fixed-width column;
    - `cell(row, name)`, one value, typed from the generated relation; strings decode lazily through `TextDecoder`, or through a WTF-8 path when the entry's lone-surrogate bit is set, and each entry decodes once;
    - `row(i)`, which builds one object for the visible row or an external output.
- **Scope.** A batch is scoped like a reader handle, because its views pin the buffer. A caller that wants an array collects it explicitly. Step 5's readers collect, and return the domain values they returned before, decoded with the same schemas; the streaming consumers (`loc check`, exports) arrive with sinks in step 8.

## 6. Queries as IR

Today's `search` request carries Browse's own filter types: `Clause { field, op, values }`, `LocationScope`, `without_notes`, `lines` and the localization scope (`ix/engine_types.rs:143-163,208-233`). Phase 4 replaces them with the rule IR (decision 32).

```jsonc
{
  "query": {
    "reader": "h1",
    "findings": "layer-7",
    "cultures": ["de", "fr"],        // the list's culture scope (Phase 3 §2)
    "where": { "and": [ … ] },      // an Expr over the `line` subject
    "text": { "query": "quit", "capability": "source" },
    "order": "display",
    "parts": {
      "rows": { "columns": ["id", "source", "key", "problems", "findings"], "range": [0, 50] },
      "counts": true,
      "facets": ["problem", "finding", "folder"],
      "groups": { "by": "finding", "open": ["localization.long"], "firstRows": 50 }
    },
    "sink": null
  }
}
```

- **`where` is an `Expr` over `line`**, evaluated with the rule compiler (`ix/rules/ir.rs`). Every Browse filter field becomes a field or function of `line`: problem, finding, fact, folder, asset, asset type, origin, audience, editing, translator notes, line state and the path scope. Culture-scoped fields are read through two new IR forms, `anyCulture` and `everyCulture`, over the request's `cultures` on `line_culture` fields. Rules can use them as well.
- **The row-set compiler** maps the shapes Phase 3's atoms cover (`eq`/`in` on a field, `finding`, `not`, `and`, `or`) to cached row sets. Anything else is evaluated per row over the candidate set the atoms leave, with the same kernels the rules use. One predicate language serves rules and queries, and a Browse filter can later become a rule as it stands.
- **Text stays its own part of the request:** `text` is ANDed with `where` and searched through the trigram index (Phase 3 §4) with today's capabilities.
- **Parts** keep Phase 3's meaning and budgets (Phase 3 §3; decision 28), now as fields of `parts`.
    - `rows` takes `columns` and either `range` or a cursor.
    - A rows part over 500 rows makes the request bulk (§4) and streams batches, so the 50-row cap goes (`ix/engine_types.rs:6`). TypeScript's paged loops (`gt/native-query.ts:265,294,461,492`) become one request, and the CLI's `--limit` cap of 50 (`apps/cli/src/command-model.ts:143,287`) goes.
- **`line` replaces `focus`, `localization_focus`, `localization_detail` and `related`** (decision 33). It takes a line ID and any of `detail`, `places` (range), `translations` (cultures) and `related`. Selecting a row is one request. The related-line probe Phase 3 measured sent 444.
- **TypeScript builds the IR.** The Browse filter model (`ext/game-text-filter-model.ts`) and the investigation request (`gt/investigation.ts`) translate clauses into `Expr` with small builders. The translation is tested by the fixture's Browse cases, not by a mirror.

## 7. Progress

- **`progress` frames** carry `{ stage, completed, total?, unit }`. The engine sends at most one every 100 ms per request, plus one at each stage boundary.
    - `findings_evaluate` reports per rule and per row chunk. Today the host reports two events, before and after (`gt/index-steps.ts:807-828`).
    - `open` reports its preparation stages (`ix/engine.rs:375-408`).
    - A sink reports rows written.
- **TypeScript.** A call that reports progress returns `{ progress: Stream<Progress>, result: Effect<…> }`. The workspace publishes progress through a `PubSub` instead of holding the latest event (`gt/workspace.ts:218-221`).
- **Workbench** forwards it to the renderer as `game-text:progress` events through the window's `send` (`apps/workbench/src/main/adapters/electron-window.ts:203-220`). The route subscribes to them; its 250 ms poll (`ext/game-text-query-route.tsx:309`) and the `game-text:progress` request are deleted.
- **Operations' 500 ms state poll** (`ext/game-text-operations.tsx:122`) reads operation state, not the engine, and stays.

## 8. Sinks

The engine encodes every exported row, so the host never builds a document to print or write one.

- **`sink: { "file": path, "format": … }`** writes the rows part's rows to a file. The request ends with `{ summary: { rows, bytes } }`.
- **`sink: { "stream": … }`** sends the encoded rows as `text` frames, which the host writes straight to its destination.
- **Formats:**

    | Format              | Today                                                | Output                      |
    | ------------------- | ---------------------------------------------------- | --------------------------- |
    | `corpusCsv`         | `gt/csv.ts:95` (`gameTextCsv`)                       | Browse's CSV                |
    | `qualityCsv`        | `gt/csv.ts:180`, `gt/localization-workspace.ts:1505` | Quality's CSV               |
    | `cultureLinesCsv`   | `gt/localization-export.ts:62`                       | the all-languages CSV       |
    | `reportCsv`         | `gt/workspace-localization.ts:797-837`               | the status report CSV       |
    | `findingJson`       | `gt/localization-check-report.ts:170-210`            | `loc check`'s finding array |
    | `investigationJson` | `gt/investigation.ts:183-196,272-320`                | the investigation's rows    |

- **JSON envelopes.** The two JSON formats emit array elements. The host writes the document around them:
    - the report header and diagnostics for `loc check`;
    - the metadata for an investigation.

    Every output stays byte-identical to today's (decision 37).

- **`loc check` streams.** It writes the report's head, then streams `findingJson` from `findings_query` with `sink.stream`, then its diagnostics and tail. Today it builds the whole report (`gt/localization-check-report.ts:148-253`) and then prints it in parts (`apps/cli/src/cli-runtime.ts:137-153`). Its peak memory no longer grows with the number of findings.
- **Workbench exports** write through `sink.file` and report progress. The 64 MiB and 16 MiB caps (`gt/workspace-localization.ts:861-904`) go.

## 9. Host adoption

- **`ua/`.**
    - `GameTextEngineSession` replaces `nativeGameTextEngineClientLayer` and the session's use of `UassetProtocolSession`. It owns the process, the frame codec, request IDs, credits, cancellation and restarts.
    - Its methods return `Effect` for small answers and `Stream<Batch<R>>` or `{ progress, result }` for the rest.
- **`gt/`.** `native-query.ts`, `native-findings.ts` and `index-query-native.ts` adopt the session:
    - one session per host, its readers in an `RcMap` by snapshot;
    - the interactive and bulk lanes and their semaphores deleted;
    - `NativeTextQuery`'s methods kept where their callers' needs haven't changed, with their bodies replaced.

    The workspace, Quality (`gt/quality-query.ts`, `gt/localization-workspace.ts`), investigation, export and `loc check` read batches.

- **Workbench.**
    - Browse's route sends `query`, and its row selection sends `line`.
    - It subscribes to progress, and its exports use sinks.
    - What reaches the renderer is still the visible rows as objects (decision 34).
- **CLI.** `loc check`, `text` list commands and exports stream.
- **Public API.** `@ue-shed/game-text`'s entry points keep their names. Where a result changes from an array to a stream, the change is a major changeset. Electroswag adopts it in Phase 6.

## 10. Deleted

| What                                                                                                                                | Notes                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Operation::GameTextEngine`, the engine's NDJSON path and its minor split                                                           | `io/protocol.rs:72-76,627-637`; `ua/game-text-engine-client.ts:19-25`                                                                                                                                                                        |
| `payload: String` and its 16 MiB reply cap                                                                                          | `packages/protocol/src/game-text-engine.ts:6,31-39,71,100`; `ix/engine.rs:306-307,567-573`                                                                                                                                                   |
| Every `output` path and the `{bytes}` replies, the `native-read-` temp directories, and the findings spill file                     | `ix/engine.rs:465-564`; `ix/engine_export.rs`; `ix/rules/findings_read.rs:99-135`; `gt/native-query.ts:238-584`                                                                                                                              |
| `search`, `focus`, `localization_focus`, `localization_detail`, `related`, `corpus*`, `aggregate`, `export`, `localization_*export` | Replaced by `query` and `line`                                                                                                                                                                                                               |
| `Clause`, `FilterField`, `LocationScope` and the 50-row `MAX_PAGE`                                                                  | `ix/engine_types.rs:6,143-163`                                                                                                                                                                                                               |
| The engine's Effect Schemas and the per-frame Schema decode                                                                         | `packages/protocol/src/game-text-engine.ts`; `ua/protocol-transport.ts:60-91,131-241` for the engine. The generated types replace them.                                                                                                      |
| The interactive and bulk lanes, their semaphores and the read shield                                                                | `gt/native-query.ts:71-212`                                                                                                                                                                                                                  |
| The TS CSV and report writers                                                                                                       | `gt/csv.ts`, `gt/localization-export.ts`, the report and investigation row encoders. Their tests become byte-identity tests against the sinks.                                                                                               |
| The 250 ms progress poll and the `game-text:progress` request                                                                       | `ext/game-text-query-route.tsx:309`; `apps/workbench/src/main/ipc/game-text.ts:78`                                                                                                                                                           |
| The TS reference oracles (decision 26) and the second TS reader they and the join fuzz harness still use                            | `gt/query.test-support.ts`, `gt/columnar-query.test-support.ts`, `gt/joined-query-data.test-support.ts`, `scripts/columnar-join-fuzz.test-support.ts:926-928`. The fixture's planted answers are the oracle; fuzz runs compare against them. |

## 11. Spans and profiles

- Every terminal frame carries the engine's profile: stages, kernels, rows, bytes and memory (private and working set). The host turns it into child spans of the call's span, as today (`ua/game-text-engine-client.ts:117-125`, `gt/native-findings.ts:16-75`).
- New spans:
    - `GameTextEngine.queueWait`, per request and class;
    - `GameTextEngine.firstFrame`, from send to the first `part` or `batch`;
    - `GameTextEngine.cancel`, from interruption to the terminal frame;
    - `GameTextEngine.restart`.
- Profile counters: `batches`, `batchBytes`, `creditStallMs`, and `cancelLatencyMs` on a cancelled request.
- The benchmark channel (`ue-shed.game-text-benchmark`) keeps its stage names where they still exist. `tsBulkRead` and `tsPayloadDecode` become `tsBatchView` and `tsRowObjects`.
- **Probes** (ADR 0012, "Measure to confirm"). A test feature makes the engine:
    - panic inside a request;
    - abort the process;
    - read a truncated index.

    Each probe has a test of the host's behaviour: a typed failure, the session's survival or restart, and handles reopened.

## 12. Fixture

- **Exact.** The fixture is exact on both canonical corpora through the new API, and one 10,000-line fuzz run is clean. The fuzz run compares against planted answers only (§10).
- **Byte-identical.** Every sink's output is byte-identical to Phase 3's on both canonical corpora: Browse, Quality and all-languages CSVs, the report CSV, the investigation JSON and `loc check`.
- **Concurrency tests:**
    - a keystroke `query` answers while `findings_evaluate` runs;
    - cancelling each bulk request mid-stream ends it with `cancelled` and leaves the session usable;
    - two hosts' worth of interleaved requests return the same answers as the same requests one at a time.

## 13. Decisions taken in Phase 4

Accepted by the owner on 2026-10-25.

30. **The engine gets its own binary session.** Other `uasset-io` operations keep NDJSON: their frames are small and none of them streams rows. Moving them too would turn this phase into a rewrite of a transport the engine no longer uses.
31. **One process per host, not one process per lane.** The lanes exist only because a process answers one request at a time. Request classes give the same isolation without a second reader, so memory drops by one reader per open snapshot. The cost: a crash now fails interactive and bulk work together, and the session restarts both.
32. **Browse queries are IR.** One predicate language for rules and queries means one compiler and one set of kernels. Browse's own filter types go, and the row-set compiler keeps Phase 3's speed for every filter Browse can express today. Every Browse filter field becomes an IR field, which makes them available to rules as well.
33. **Selecting a row is one `line` request** with the parts the page shows.
34. **The renderer still receives visible rows as objects.** It never gets more than one page, so transferring buffers to it would save copying about 50 objects. Batches stop in the main process and the CLI, where the bulk data is.
35. **Each batch has its own string table.** A batch is then self-contained and can be released on its own. A request-wide dictionary would save bytes on repeated folder and asset names, but it would pin every batch's strings until the request ends.
36. **Credit-based flow control, 8 frames per request.** Without it, a slow consumer's backlog grows without bound in the host.
37. **The engine encodes every exported row, byte-identical to today.** The TS writers are deleted, not kept as a second implementation. Hosts write only JSON envelopes.
38. **The 50-minute request deadline goes.** Cancellation replaces it as the way to stop a request, and the stuck-session rule (§4) covers an engine that doesn't answer a cancel.

## 14. Order of work, one commit per step at least

1. **Docs.** This specification, and ADR 0012's phasing corrected: Phase 3 deferred binary frames, column batches and the deletions to Phase 4, as its own spec says (Phase 3 §1).
2. **The session and frames** (§2, §3).
    - `uasset game-text-engine`, the frame codec on both sides and generated types for every request and reply.
    - Today's actions move over unchanged, still answering with JSON parts and files.
    - Delete the engine's NDJSON path, `payload: String` and the engine Schemas.
3. **Concurrency** (§4): classes, pools, the writer's priority, credits, shared readers and caches.
    - One process per host replaces the lanes.
    - Answers stay byte-identical.
4. **Cancellation and failure** (§4): the cancel frame, checkpoints, the stuck-session rule, panic containment, the probes (§11) and the read shield deleted.
5. **Column batches** (§5).
    - Every file- and page-based bulk read becomes a batch stream read through views.
    - Delete the `output` paths, temp directories, spill file and paged loops.
6. **Progress** (§7): frames, the workspace's `PubSub` and Workbench events. Delete the poll.
7. **Queries as IR** (§6): `query` and `line`, `anyCulture`/`everyCulture`, and Browse, Quality and the investigation adopting them.
    - Delete the replaced actions, `Clause`, `LocationScope` and `MAX_PAGE`.
8. **Sinks** (§8): every format byte-identical, exports and `loc check` streaming. Delete the TS writers.
9. **The oracles** (§10): delete the reference oracles and the second reader; the fuzz harness compares against planted answers.
10. **Parity:** the fixture exact, one 10,000-line fuzz run, and every sink byte-identical. Then the Phase 0 measurement set against Phase 3, plus:
    - a matching keystroke's p95 while `findings_evaluate` runs;
    - cancel latency, p50 and p95, during an evaluation and during an all-rows export;
    - a 5,000-row findings page from request to the visible page, batches against Phase 3's JSON;
    - `loc check` end to end: time and peak memory, host and engine;
    - the all-languages CSV export: time and peak memory;
    - the engine's resident memory with one snapshot open: one process against Phase 3's two.

    Then the owner review.
