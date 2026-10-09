import collections
import json
from evidence import OUT, DOCS
from analyze import events, segments
from report import write

proofs = {}
rows = []
samples = {}
for version in ["5.7", "5.8"]:
    data = json.loads((OUT / version / "concurrent-summary.json").read_text())
    by_label = {item["label"]: item for item in data}
    groups = segments(events(version, "concurrent"))
    cells = {}
    for label in ["ui-before", "ui-after-apply", "ui-after-refresh", "ui-after-editor-cell"]:
        candidates = [cell for cell in by_label[label]["result"]["cells"] if "SListPanel[0]/SDataTableListViewRow[0]/SHorizontalBox[4]" in cell["widgetPath"]]
        assert len(candidates) == 1, (version, label, candidates)
        cells[label] = candidates[0]
    applied = by_label["apply-with-editor-open"]["result"]["snapshots"][0]
    row = next(row for row in applied["table"]["rows"] if row["name"] == "Scalar_Alpha")
    field = next(field for field in row["fields"] if field["name"] == "Count")
    stale = json.loads(by_label["stale-apply"]["error"])
    summary = {"open": by_label["open"]["result"], "uiCells": cells, "confirmedValue": field["value"], "staleResult": stale, "dirtyRevert": by_label["dirty-revert"]["result"], "revertFingerprint": by_label["after-revert-snapshot"]["result"]["fingerprint"], "supplemental": {label: by_label[label]["result"] for label in ["stringtable-write", "stringtable-after-undo", "stringtable-after-redo", "stringtable-raw"]}, "hooks": {label: dict(collections.Counter(event["hook"] for event in group)) for label,group in groups.items()}}
    proofs[version] = summary
    rows.append(f"| {version} | true | {cells['ui-before']['text']} | {field['value']['value']} | {cells['ui-after-apply']['text']} | {cells['ui-after-refresh']['text']} | {cells['ui-after-editor-cell']['text']} | {stale['status']}, {stale['errors'][0]['code']} |")
    labels = ["tagged-property", "tagged-undo", "tagged-redo", "dirty-revert", "text-property", "stringtable-write", "stringtable-undo", "stringtable-redo", "stringtable-raw"]
    sample = []
    for label in labels:
        sample.append({"scenario": label})
        sample.extend(groups[label])
    assert len(sample) <= 200
    (DOCS / f"evidence/T12-{version}-events.jsonl").write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in sample) + "\n", encoding="utf-8")
    samples[version] = {label: [{k: e[k] for k in ["hook","transactionId","operationId","context","title","eventType","properties","nonProperty","object"] if k in e} for e in groups[label] if e["hook"] in ["ObjectTransacted","TransactionState"]] for label in ["tagged-property","tagged-undo","tagged-redo"]}
(DOCS / "evidence/T12-concurrent-proof.json").write_text(json.dumps(proofs, indent=2), encoding="utf-8")
(DOCS / "evidence/T09-tagged-context-supplement.json").write_text(json.dumps(samples, indent=2), encoding="utf-8")
write("T12-concurrent-editing.md", "T12 — Concurrent editing", "Does an open DataTable editor reflect external Apply, and are stale writes rejected?", "Mutation correctness alone is insufficient if editor views stay stale or overwrite concurrent changes.", "Final `python research/sync-probe/live.py 5.7 concurrent`, then 5.8 on fresh normal editors. Open UAssetEditorSubsystem editor for DT_Scalars; FindEditorForAsset confirms open. Read cached Slate STextBlock text for first row, Count column (SListPanel[0]/SDataTableListViewRow/SHorizontalBox[4]), with row-name/header bindings validating identity. Apply Count7→8, read same binding, send only FDataTableEditorUtils pre/post RowData notifications (no value edit), read again, then editor-style Count33 write and stale-fingerprint Apply. Read source DataTableEditor.cpp 5.7:249–269 / 5.8:252–272 refresh on editor-manager PostChange. Initial reader only traversed top-level windows and returned empty; corrected to GetAllVisibleWindowsOrdered including child asset window. Initial run preserved separately and never interpreted as stale UI. This checks widget text bindings, not pixels. Supplement: dirty package reload AssumePositive and baseline fingerprint; tagged context undo/redo; FText dataasset edit; editor-style String Table transaction and raw core mutation.", "| Engine | Editor found | Initial UI Count | Apply confirmed | UI after Apply | UI after notify only | UI after native-style edit | Stale Apply |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n" + "\n".join(rows) + "\n\n**Current Apply leaves the open table row-list view stale.** Public editor-manager notifications refresh it to the confirmed value without another edit. This isolates a notification gap on both versions. No product change made. Row removal/rename while a row editor is actively editing, pixel repaint, tab selection changes and keyboard focus behavior remain UNVERIFIED.\n\nStale result is a rejected mutation with errors[0].code=fingerprint_mismatch, retrySafe=false, objectPath, expected/live hash message, snapshots=[] and request operationId. HTTP itself succeeds; domain result is rejected.\n\nDirty revert succeeded and restored original scalar fingerprint on both engines, with dirty=false. Replacement object subscriptions need reattachment; old per-table delegate is not a lifecycle-complete observer. Tagged custom context survives finalization, Undo and Redo; IDs behave as T09 described. FText property edit emits named Text property + finalized object event. String Table scoped Modify write is undoable: key exists after write, absent after Undo, restored after Redo. Its events have no key identity. Raw SetSourceString changes source but produces no requested hook. All recorded hooks were on game thread.", "[UI binding/value/error proof](evidence/T12-concurrent-proof.json), [5.7 supplement events](evidence/T12-5.7-events.jsonl), [5.8 supplement events](evidence/T12-5.8-events.jsonl), [tagged-context proof](evidence/T09-tagged-context-supplement.json). Raw `out/sync-research/VERSION/concurrent-summary.json`, concurrent-events.jsonl, T12-rpc.jsonl and T12-final-driver.log; 5.7 initial/before-refresh attempts preserved separately.", "high for cached widget values, notification fix, stale rejection, scripted undo/revert; low for active real-user controls and pixels, not exercised.", "Apply updates memory yet UI cache stays old. Supporting add/remove/rename may require correct prechange notifications to release row-editor pointers, not just repaint after mutation. 5.8 String Table editor builds require three SetSourceString args under WITH_EDITORONLY_DATA: initial C2660 corrected after reading conditional header, both final builds pass. Raw core writes are invisible.", "Reviewer manual: open DT_Scalars, select Scalar_Alpha, leave its row editor active; exercise external add/remove/rename/interactive overlap, Undo/Redo and reload, checking crashes and retained selection. Spike product-side public notifications and scoped provenance; validate row-key diff strategy.")
print(json.dumps(rows))
