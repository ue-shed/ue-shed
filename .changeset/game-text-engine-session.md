---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

The Game Text engine runs in its own binary session, `uasset game-text-engine`, instead of the
uasset-io protocol's `game_text_engine` operation, which is removed. Requests and replies are
length-prefixed frames carrying request IDs, and requests carry their values inline: the JSON
text `payload` fields are gone, and the rule document travels as an object.
`GameTextEngineRequest` and `GameTextEngineOutcome` are removed from `@ue-shed/protocol`; the
engine's types are `GameTextContract.EngineRequest`, `OpenReply`, `EngineEnd`, `EngineFailure`
and `EngineProfile`, generated from the engine. `NativeGameTextEngineClient.execute` returns an
`EngineAnswer` (its parts and profile); `answerJson` reads its reply.

One engine process serves a host: `nativeIndexQueryLayer` starts it on the first read, and every
open snapshot's reader lives in it, instead of two processes per snapshot. Requests run
concurrently in the engine, keystrokes on threads of their own, so a search answers while an
evaluation or an export runs. Interrupting a read cancels it in the engine rather than letting it
finish unseen, and a panic in the engine fails only its request.

Bulk reads stream as column batches instead of files: the corpus, its header, localization lines,
aggregates and findings pages no longer write temporary files under the cache root, and a large
findings page no longer spills to one. An `EngineAnswer` carries its `batches`, read through
`EngineBatch` views over each frame's buffer, and `answerRows` reads one part's rows; the
relations and their columns are generated as `GameTextContract.Relations`. The engine requests
lose their `output` paths, `SpilledReply` is removed, and `ReadProfile` drops `responseBytes` and
`fileFallback`; `EngineProfile` counts `batches`, `batchBytes` and `creditStallMs`.

The engine reports progress as it works: opening reports its preparation stages and an
evaluation each rule it runs. `NativeGameTextEngineClient.execute` and `findingsEvaluate` take a
progress observer, and a quality scan's `localization_quality` and `source_quality` progress
counts rules rather than lines. The workspace's `progressChanges()` streams its progress and each
change to it, and a host's project port may supply `progressChanges` so the workspace follows it
without polling.

Searches reach the engine as a `query` request instead of `search`: a selection whose `where` is
in the rule IR's grammar, and the parts the answer needs. `GameTextContract.Query`,
`QuerySelection`, `QueryParts` and `QueryAnswer` type it; the rule IR gains `anyCulture`,
`everyCulture`, `anyPlace` and `facet`, which the rule compiler refuses. A query's rows stream as
`browseUnit` and `browseLine` batches. The `aggregate`, `export` and `localization_export`
requests take a `selection` beside their own fields instead of the search fields.

A `line` request reads a selected row's sections (its places, detail, related rows and the whole
line) and replaces `focus`, `localization_detail`, `related` and `localization_focus_export`;
`GameTextContract.LineRequest` and `LineAnswer` type it. The 50-row page cap is gone:
`MAX_TEXT_QUERY_PAGE_SIZE` is 100,000, a page over 500 rows streams as a bulk read, and the CLI's
`--limit` takes up to that. A unit's places, open groups' first rows and related rows list up to
`MAX_TEXT_SECTION_ROWS` (500) at once, validated by `TextSectionRows`.

The engine encodes exports itself. A request's `sink` names a format and a file, written beside
it and moved into place, or streams the encoded rows as `text` frames that
`NativeGameTextEngineClient.execute` hands to an `EngineTextSink`, an Effect writer; it answers with a
`SinkSummary`. `NativeTextQuery.writeLocalizationLinesCsv` writes the all-languages CSV this way,
so the Workbench export and `ue-shed loc export` no longer read the lines into the host, and
the Workbench's 64 MiB cap on that file is gone. Engine errors gain the `exists` code.

`ue-shed loc check` prints its report as the engine writes the findings, so it never holds them;
the bytes are unchanged. `GameTextIndexRefreshResult.prepareLocalizationCheck` reads everything
but the findings and returns a `PreparedLocalizationCheck`, whose `write` writes the report;
`localizationCheck` still returns the report as a value. `findings_query` takes a `findingJson`
sink without a `limit`, and `NativeFindings.findingsWrite` sends one. If the engine fails after
the report starts printing, `loc check` writes the failure to stderr and exits with 2.

`NativeTextQuery.writeCorpusCsv` writes Browse's CSV through a `corpusCsv` sink on the corpus
export, so an investigation's corpus CSV asks for its file first and no unit reaches the host.
Both file writers answer with a `SinkFileWritten`.
