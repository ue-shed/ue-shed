"""Replay anonymous reader job traces with a hypothetical active-package byte budget."""
import argparse
from collections import deque
import heapq
from itertools import groupby
import json
from pathlib import Path


def peak_of_changes(changes):
    current = 0
    peak = 0
    for _, group in groupby(sorted(changes, key=lambda event: event[0]), key=lambda event: event[0]):
        current += sum(change for _, change in group)
        peak = max(peak, current)
    return peak


def replay(jobs, budget=None, workers=12, fixed_live=0, writer_capacity=0):
    if not jobs:
        return {"wallNs": 0, "livePeakBytes": fixed_live + writer_capacity,
                "activeInputPeakBytes": 0, "activeJobPeak": 0, "readyCapacityPeakBytes": 0}
    count = len(jobs)
    window = 2 * workers
    work = deque(range(min(window, count)))
    ready = deque()
    next_job = len(work)
    running = []
    starts = [0] * count
    finishes = [0] * count
    consumed = [0] * count
    active = 0
    active_bytes = 0
    max_active = 0
    busy = False
    completed = 0
    serial = 0
    now = 0

    def event(time, kind, index):
        nonlocal serial
        serial += 1
        heapq.heappush(running, (time, serial, kind, index))

    def admit():
        nonlocal active, active_bytes, max_active
        while work and active < workers:
            index = work[0]
            size = jobs[index]["inputBytes"]
            if budget is not None and active_bytes + size > budget and active:
                break
            work.popleft()
            active += 1
            active_bytes += size
            max_active = max(max_active, active)
            starts[index] = now
            duration = max(1, jobs[index]["readyNs"] - jobs[index]["startNs"])
            event(now + duration, "ready", index)

    def consume():
        nonlocal busy, next_job
        if not busy and ready:
            index = ready.popleft()
            busy = True
            if next_job < count:
                work.append(next_job)
                next_job += 1
            duration = max(1, jobs[index]["endNs"] - jobs[index]["consumeNs"])
            event(now + duration, "consumed", index)

    admit()
    while running:
        now, _, kind, index = heapq.heappop(running)
        if kind == "ready":
            active -= 1
            active_bytes -= jobs[index]["inputBytes"]
            finishes[index] = now
            ready.append(index)
            admit()
            consume()
            admit()
        else:
            consumed[index] = now
            completed += 1
            busy = False
            consume()
            admit()
    if completed != count:
        raise ValueError("replay did not finish")
    memory = []
    inputs = []
    queued = []
    for index, job in enumerate(jobs):
        start = starts[index]
        finish = finishes[index]
        end = consumed[index]
        size = job["inputBytes"]
        staged = job["stagedCapacity"]
        inputs.extend(((start, size), (finish, -size)))
        queued.extend(((finish, staged), (end, -staged)))
        previous_ns = 0
        previous_value = 0
        for point in job["points"]:
            value = max(point["intervalPeakBytes"], point["liveBytes"])
            memory.append((start + previous_ns, value - previous_value))
            previous_ns = point["ns"]
            previous_value = value
        memory.append((finish, staged - previous_value))
        memory.append((end, -staged))
    return {"wallNs": now, "livePeakBytes": fixed_live + writer_capacity + peak_of_changes(memory),
            "activeInputPeakBytes": peak_of_changes(inputs), "activeJobPeak": max_active,
            "readyCapacityPeakBytes": peak_of_changes(queued)}


def summarize(trace, driver):
    samples = trace["samples"]
    jobs = trace["jobs"]
    if trace["droppedJobs"] or trace["droppedSamples"]:
        raise ValueError("trace was truncated")
    if not trace["heapCounting"] or not all(
            job["endNs"] >= job["consumeNs"] >= job["readyNs"] > job["startNs"] > 0
            for job in jobs):
        raise ValueError("trace is incomplete")
    gaps = [b["ns"] - a["ns"] for a, b in zip(samples, samples[1:])]
    peak_ws = max(samples, key=lambda sample: sample["workingSetBytes"])
    peak_live = max(samples, key=lambda sample: sample["heapLiveBytes"] or 0)
    idle = [sample for sample in samples if sample["idle"]]
    end = idle[-1] if idle else samples[-1]
    last_work = max(job["endNs"] for job in jobs)
    core_start = min(job["startNs"] for job in jobs)
    buffers = [(job["readyNs"], job["stagedCapacity"]) for job in jobs] + [
        (job["endNs"], -job["stagedCapacity"]) for job in jobs]
    active_inputs = [(job["startNs"], job["inputBytes"]) for job in jobs] + [
        (job["readyNs"], -job["inputBytes"]) for job in jobs]
    before = [sample for sample in samples if sample["ns"] <= core_start]
    fixed = max((sample["heapLiveBytes"] or 0 for sample in before), default=0)
    fixed = max(fixed, end["heapLiveBytes"] or 0)
    # Root and group buffers have dropped at idle; keep their measured capacities in the replay.
    fixed += sum(trace["tableBytes"][1:])
    measured_live = peak_live["heapLiveBytes"]
    return {"jobs": len(jobs), "inputBytes": sum(job["inputBytes"] for job in jobs),
            "largestInputBytes": max(job["inputBytes"] for job in jobs),
            "coreWallNs": last_work - core_start, "setupNs": trace["coreStartNs"],
            "sampleMaxGapNs": max(gaps), "peakWorkingSetBytes": driver["peakWorkingSetBytes"],
            "peakPrivateBytes": driver["peakPrivateBytes"], "sampledLivePeakBytes": measured_live,
            "workingSetPeakSample": peak_ws, "livePeakSample": peak_live, "idleSample": end,
            "fixedLiveBytes": fixed, "tableBytes": trace["tableBytes"],
            "readyCapacityPeakBytes": peak_of_changes(buffers),
            "activeInputPeakBytes": peak_of_changes(active_inputs),
            "largestJobs": sorted(jobs, key=lambda job: job["inputBytes"], reverse=True)[:10],
            "slowestJobs": sorted(jobs, key=lambda job: job["readyNs"]-job["startNs"], reverse=True)[:10]}


def analyze(directory, budgets):
    directory = Path(directory)
    traces = list(directory.glob("reader-memory-*.json"))
    if len(traces) != 1:
        raise ValueError("expected one trace")
    trace = json.loads(traces[0].read_text(encoding="utf-8"))
    driver = json.loads((directory / "driver.json").read_text(encoding="utf-8"))
    result = summarize(trace, driver)
    writer = max(sample["writerCapacity"] for sample in trace["samples"])
    fixed = result["fixedLiveBytes"]
    rows = []
    for budget in [None] + budgets:
        row = replay(trace["jobs"], budget, 12, fixed, writer)
        row["budgetBytes"] = budget
        rows.append(row)
    result["simulation"] = rows
    result["simulationAssumptions"] = [
        "12 workers, existing two-jobs-per-worker delivery window and one coordinator",
        "FIFO admission immediately before read; input-byte credits released at staged readiness",
        "One input larger than the budget may run alone",
        "Measured per-package service and coordinator times stay fixed",
        "Live memory is a conservative interval-peak envelope from bounded allocation checkpoints",
        "Live-byte estimates exclude allocator slack, OS allocations and file cache; they are not RSS limits"
    ]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("--output", required=True)
    parser.add_argument("--budgets-mib", default="64,96,128,192,256,384")
    options = parser.parse_args()
    budgets = [int(number) * 2**20 for number in options.budgets_mib.split(",")]
    result = analyze(options.directory, budgets)
    Path(options.output).write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    compact = {key: value for key, value in result.items() if key not in ("largestJobs", "slowestJobs")}
    print(json.dumps(compact, indent=2))


if __name__ == "__main__":
    main()
