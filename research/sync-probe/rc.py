"""Research-only RC client. No retries for mutation calls; raw exchanges retained."""
import json
import os
import time
import urllib.request
import urllib.error
from evidence import OUT

ENDPOINT = os.environ.get("UE_SHED_REMOTE_CONTROL_ENDPOINT", "http://127.0.0.1:30001")
PROBE = "/Script/UEShedSyncProbe.Default__UEShedSyncProbeLibrary"
AUTHORING = "/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary"


class Client:
    def __init__(self, version, task):
        self.log = OUT / version / f"{task}-rpc.jsonl"

    def request(self, route, body=None, method="PUT"):
        started = time.perf_counter()
        request = urllib.request.Request(ENDPOINT + route, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status, raw = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read().decode()
        elapsed = (time.perf_counter() - started) * 1000
        result = json.loads(raw) if raw else {}
        record = {"seconds": time.perf_counter(), "route": route, "request": body, "status": status, "ms": elapsed, "response": result}
        with self.log.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        if status != 200:
            raise RuntimeError(f"HTTP {status}: {result}")
        return result, elapsed

    def call(self, library, function, **parameters):
        result, elapsed = self.request("/remote/object/call", {"objectPath": library, "functionName": function, "parameters": parameters, "generateTransaction": False})
        return json.loads(result["ResultJson"]), elapsed

    def probe(self, function, **parameters):
        return self.call(PROBE, function, **parameters)[0]

    def scenario(self, action, **parameters):
        return self.probe("Scenario", RequestJson=json.dumps({"action": action, **parameters}))

    def snapshot(self, path):
        return self.call(AUTHORING, "GetTableSnapshot", TableObjectPath=path)[0]


if __name__ == "__main__":
    import sys
    client = Client(sys.argv[1], "T07-smoke")
    print(json.dumps(client.probe("GetCounts"), indent=2))
    print(json.dumps(client.snapshot("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"), indent=2)[:12000])
