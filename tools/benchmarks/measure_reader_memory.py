"""Run a standalone staged extraction without retaining input identities in measurements."""
import argparse
import atexit
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


class Memory(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "peak_ws", "ws", "peak_paged", "paged", "peak_nonpaged", "nonpaged",
            "pagefile", "peak_pagefile", "private"
        )
    ]


def run(label, executable, workers, output, environment_file, variable, records_root, capture=True):
    destination = Path(output)
    destination.mkdir(exist_ok=False)
    stage = destination / "staged"
    stage.mkdir()
    env_text = Path(environment_file).read_text(encoding="utf-8-sig")
    project = re.search(r'^\$env:' + re.escape(variable) + r'\s*=\s*"([^"]+)"', env_text, re.M)[1]
    pairs = []
    retained = Path(records_root)
    for file in retained.glob("*.ndjson"):
        group = int(file.stem)
        with file.open(encoding="utf-8") as stream:
            for line in stream:
                value = json.loads(line)
                pairs.append((value.get("path") or value["record"]["path"], group))
    pairs.sort(key=lambda pair: pair[0].encode("utf-8"))
    request = {"contract": {"name": "uasset-io", "version": {"major": 1, "minor": 19}},
               "requestId": "reader-memory", "limits": {"concurrency": int(workers)},
               "operation": {"kind": "extract_text_packages", "projectRoot": project,
                             "paths": [p[0] for p in pairs],
                             "staging": {"directory": str(stage), "groups": [p[1] for p in pairs]}}}
    environment = dict(os.environ)
    environment.pop("UE_SHED_COLD_SCAN_MEASURE_DIR", None)
    environment.pop("UE_SHED_READER_MEMORY_DIR", None)
    if capture:
        environment["UE_SHED_READER_MEMORY_DIR"] = str(destination)
    binary_hash = hashlib.sha256(Path(executable).read_bytes()).hexdigest()
    started = time.perf_counter_ns()
    process = subprocess.Popen([executable, "protocol"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=environment, creationflags=subprocess.CREATE_NO_WINDOW)
    def cleanup():
        if process.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=False)
            process.wait(timeout=10)
    atexit.register(cleanup)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Memory), wintypes.DWORD]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x410, False, process.pid)
    if not handle:
        raise RuntimeError("process counter handle unavailable")
    samples = []
    stop = threading.Event()
    errors = []

    def cpu_time():
        values = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *[ctypes.byref(v) for v in values]):
            return None
        return sum((v.dwHighDateTime << 32) | v.dwLowDateTime for v in values[2:]) * 100

    def sample():
        while not stop.is_set():
            memory = Memory()
            memory.cb = ctypes.sizeof(memory)
            if kernel.K32GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                samples.append({"ns": time.perf_counter_ns() - started, "workingSetBytes": memory.ws,
                                "privateBytes": memory.private, "peakWorkingSetBytes": memory.peak_ws,
                                "peakPrivateBytes": memory.peak_pagefile, "cpuNs": cpu_time()})
            stop.wait(0.1)

    observer = threading.Thread(target=sample, daemon=True)
    observer.start()
    stderr = []
    stderr_thread = threading.Thread(target=lambda: stderr.append(process.stderr.read()), daemon=True)
    stderr_thread.start()
    frames = 0
    staged = 0
    complete = None
    process.stdin.write(json.dumps(request, separators=(",", ":")).encode("utf-8"))
    process.stdin.close()
    for line in process.stdout:
        value = json.loads(line)
        frames += 1
        if value.get("kind") == "result" and value.get("result", {}).get("kind") == "staged_text_package":
            staged += 1
        if value.get("kind") == "complete":
            complete = value.get("outcome")
        if value.get("kind") in ("error", "failed", "rejected"):
            errors.append(value.get("kind"))
    code = process.wait()
    elapsed = time.perf_counter_ns() - started
    total_cpu = cpu_time()
    stop.set()
    observer.join()
    stderr_thread.join()
    kernel.CloseHandle(handle)
    group_hashes = {}
    records = 0
    staged_bytes = 0
    for file in stage.glob("*.ndjson"):
        lines = file.read_bytes().splitlines(keepends=True)
        if any(not line.endswith(b"\n") or line == b"\n" for line in lines):
            raise RuntimeError("invalid staged line framing")
        staged_bytes += sum(map(len, lines))
        records += len(lines)
        digest = hashlib.sha256()
        for line in sorted(lines):
            digest.update(line)
        group_hashes[file.stem] = digest.hexdigest()
    summary = {"label": label, "workers": int(workers), "capture": capture,
               "binarySha256": binary_hash, "pid": process.pid, "exitCode": code,
               "elapsedNs": elapsed, "cpuNs": total_cpu, "frames": frames,
               "stagedResults": staged, "records": records, "stagedBytes": staged_bytes,
               "groups": group_hashes, "stderrBytes": sum(map(len, stderr)),
               "errors": errors,
               "peakWorkingSetBytes": max((s["peakWorkingSetBytes"] for s in samples), default=0),
               "peakPrivateBytes": max((s["peakPrivateBytes"] for s in samples), default=0),
               "sampleMaxGapNs": max((b["ns"] - a["ns"] for a, b in zip(samples, samples[1:])), default=0),
               "samples": samples}
    (destination / "driver.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("label", "workers", "exitCode", "elapsedNs", "cpuNs",
                                             "records", "stagedBytes", "peakWorkingSetBytes",
                                             "peakPrivateBytes", "sampleMaxGapNs")}))
    if capture and len(list(destination.glob("reader-memory-*.json"))) != 1:
        raise RuntimeError("reader memory capture unavailable")
    if code or errors or len(pairs) != records:
        raise RuntimeError("standalone extraction did not complete")


if __name__ == "__main__":
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--label", required=True)
    arguments.add_argument("--executable", required=True)
    arguments.add_argument("--workers", type=int, required=True)
    arguments.add_argument("--output", required=True)
    arguments.add_argument("--environment-file", required=True)
    arguments.add_argument("--variable", default="BENCH_RELEASED_PROJECT")
    arguments.add_argument("--records", required=True)
    arguments.add_argument("--control", action="store_true")
    options = arguments.parse_args()
    try:
        run(options.label, options.executable, options.workers, options.output,
            options.environment_file, options.variable, options.records, not options.control)
    except Exception as error:
        print(json.dumps({"failure": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
