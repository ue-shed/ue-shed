import json
from evidence import OUT, DOCS
from analyze import events, segments
from report import write

evidence = {}
latency_rows = []
growth_rows = []
event_rows = []
policy_rows = []
for version in ["5.7", "5.8"]:
    evidence[version] = {}
    for mode in ["focused", "minimized-throttle-off", "minimized-throttle-on"]:
        path = OUT / version / f"perf-{mode}-summary.json"
        if not path.exists(): continue
        source = json.loads(path.read_text())[0]
        actual = "foreground" if source["windowStart"]["editorForeground"] and source["windowEnd"]["editorForeground"] else "unfocused"
        actual += ", minimized" if all(w["minimized"] for w in source["windowStart"]["editorWindows"]) else ", visible"
        compact = {k:v for k,v in source.items() if k not in ["samples", "sequentialSamples"]}
        evidence[version][mode] = compact
        for operation, stats in source["stats"].items():
            latency_rows.append(f"| {version} | {mode} ({actual}) | {source['before']['throttleCPUWhenNotForeground']} | {operation} | {stats['n']} | {stats['p50']:.1f} | {stats['p95']:.1f} | {stats['max']:.1f} |")
        before, after = source["before"], source["after"]
        seq = source["sequential"]
        growth_rows.append(f"| {version} | {mode} | {seq['p50']:.1f} / {seq['p95']:.1f} / {seq['max']:.1f} | {before['queueLength']} → {after['queueLength']} | {before['undoBytes']} → {after['undoBytes']} | {before['processPhysicalBytes']/1048576:.1f} → {after['processPhysicalBytes']/1048576:.1f} |")
    for label in ["cell", "dataasset-property", "actor-property", "interactive"]:
        group = segments(events(version, "matrix"))[label]
        start = next(e for e in group if e["hook"] == "MutationStart")
        target_hook = "DataTableChanged" if label == "cell" else "PropertyChanged"
        event = next(e for e in group if e["hook"] == target_hook and e.get("object") == start["object"] and e["seconds"] >= start["seconds"])
        elapsed = (event["seconds"] - start["seconds"]) * 1000
        evidence[version].setdefault("eventLatency", []).append({"scenario": label, "hook": target_hook, "ms": elapsed, "startCounter": start["counter"], "eventCounter": event["counter"]})
        event_rows.append(f"| {version} | {label} → {target_hook} | {elapsed:.3f} |")
    evidence[version]["normalPolicy"] = {}
    for mode in ["visible-off", "visible-on", "minimized-off", "minimized-on"]:
        item = json.loads((OUT / version / f"policy-{mode}.json").read_text())
        evidence[version]["normalPolicy"][mode] = {k:v for k,v in item.items() if k != "samples"}
        for operation, stats in item["stats"].items():
            policy_rows.append(f"| {version} | {mode} | {item['before']['effectiveShouldThrottle']} | {item['before']['appHasFocus']} | {operation} | {stats['p50']:.1f} | {stats['p95']:.1f} | {stats['max']:.1f} |")
(DOCS / "evidence/T11-performance.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
write("T11-latency-and-throughput.md", "T11 — Latency and throughput", "Are per-edit RC Apply and reverse observation fast enough, including large tables and background operation?", "One-cell target is ≤100 ms p95; background and whole-table cost can determine feasibility.", "`python research/sync-probe/windows.py VERSION focus`; `python research/sync-probe/live.py VERSION perf focused`; minimize and run `perf minimized-throttle-off`; `rc.Client.scenario('throttle', value=True)` and run `perf minimized-throttle-on`. 5.7 first, then 5.8; one editor per engine retained between modes. windows.py records Win32 foreground PID and IsIconic. Ten no-op warmups, then 40 interleaved rounds per mode, each with no-op, one-cell small-table Apply, five small-table Apply, large snapshot and one-cell large Apply, followed by 200 sequential one-cell small-table Applies. Mutation IDs unique, fresh fingerprints/returned confirmations used. Nearest-rank p50/p95/max. Timer covers urllib HTTP request/response body read; excludes response JSON decoding and raw-client logging after read, includes request encoding; game-thread synchronous probe JSONL writing remains enabled. No concurrent builds/gates during measurements. Record engine setting from GetCounts, not requested label alone. Background source EditorEngine.cpp 5.7:5025–5068 / 5.8:5316–5359 includes foreground/focus checks, disable-throttling delegates and loading/shader exemptions; UI RC warning in SRemoteControlPanel.cpp:666–689 both versions.", "All numbers in ms. **The requested focused mode failed foreground activation on both engines where native evidence says unfocused. Those rows are visible/unfocused measurements; actual focused performance remains UNVERIFIED.**\n\n| Engine | Requested mode (actual state) | Throttle setting | Operation | n | p50 | p95 | max |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n" + "\n".join(latency_rows) + "\n\nDT_LargeScalars contains 10,000 rows. Five-table batch uses Scalars, ScalarsOverride, Structs, RightReferences and Text (small tables); large Apply is measured separately. These are loopback RC timings on this machine, not full client UI latency, WAN measurements or guarantees. First visible/unfocused 5.7 mode retained full large responses in raw log; later modes retain byte-size/SHA256 summaries to avoid repeated huge payloads. Client logging lies outside timer but changes pacing.\n\n**200 sequential small-table edits per mode** (p50/p95/max in ms; RSS in MiB):\n\n| Engine | Mode | Apply times | Queue entries | Undo bytes | Process physical MiB |\n| --- | --- | --- | --- | --- | --- |\n" + "\n".join(growth_rows) + "\n\nMemory is process-level, not a precise allocation measurement of backups. Apply cache is bounded to 128 operation results (`UEShedAuthoringLibrary.cpp:1346–1358`), so the 200 small edits evict earlier large cached results; GC and retained transactions also affect RSS. Undo queue/bytes isolate history growth better than RSS. No claim about peak duplicate-table allocation or time isolated to fingerprinting can be made from these numbers. Large Apply aggregates backups, fingerprinting, mutation, engine serialization and HTTP response transfer.\n\n**Editor-side hook latency:** one sample per scripted case, from immediately-before-value-write MutationStart timestamp to first same-object hook; includes writing the marker and is not network push latency.\n\n| Engine | Source → hook | ms |\n| --- | --- | --- |\n" + "\n".join(event_rows), "[Compact timings/state/memory](evidence/T11-performance.json); raw `out/sync-research/{5.7,5.8}/perf-*-summary.json`, `T11-rpc.jsonl`, `window-state.jsonl`, matrix-events.jsonl. Each mode has explicit before/after native window state and engine throttle setting.", "high for measured loopback modes and sample quantiles; low for actual focused performance and isolated allocation causality.", "Large-table whole snapshots/Apply may miss the live target badly even when small edits pass. Enabling background throttle can dominate HTTP timing; minimized windows can also trigger source throttling independently of setting. Focus activation failed in the unattended desktop. RSS decreases do not prove edits are cheap.", "Profile large Apply CPU/allocation stages; test delta confirmations/observations as a separate spike; repeat focused after a human unlocks/activates the desktop; verify steady-state long-session history and more table shapes. Effective background policy should be instrumented directly, not inferred solely from the setting.")
print(json.dumps({v: {m: entry['stats']['one']['p95'] for m, entry in evidence[v].items() if 'stats' in entry} for v in evidence}))
path = DOCS / "T11-latency-and-throughput.md"
text = path.read_text(encoding="utf-8")
text = text.replace("All numbers in ms.", "All numbers in ms. The full 40-round/200-sequential datasets below launch with **-unattended**, which bypasses CPU throttling at `EditorEngine.cpp 5.7:5014–5023 / 5.8:5305–5314`. 5.8 has one full visible/unfocused dataset; redundant unattended minimized large-table runs were skipped after this source finding. Normal-editor background effects were instead tested directly below.")
text = text.replace("Evidence: ", "**Normal editors without -unattended:** `UE_SHED_RESEARCH_EDITOR_UNATTENDED=0 python research/sync-probe/fixture.py launch VERSION`; `python research/sync-probe/policy.py VERSION visible-off`, then visible-on; minimize and run minimized-off/on. Each has 40 no-op and 40 one-cell trials. Captures effective ShouldThrottleCPUUsage, FApp focus, native foreground, setting and unattended flag before/after. No large-table or five-table normal-policy trials in these short runs.\n\n| Engine | Mode/setting | Effective throttle | App focus | Operation | p50 | p95 | max |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n" + "\n".join(policy_rows) + "\n\nVisible/unfocused with the setting disabled passes the target. Enabled setting and all-windows-minimized cases miss it. A minimized editor throttles even when the checkbox is false. Source offers disable-throttling delegates before the focus/minimized checks (`EditorEngine.cpp:5025–5032 / 5316–5323`); using a scoped delegate during a sync lease is a **proposed workaround, not tested**. Do not infer normal-editor latency from unattended runs.\n\nEvidence: ", 1)
path.write_text(text, encoding="utf-8")
