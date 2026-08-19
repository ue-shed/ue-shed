import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [, , mode, evidencePath] = process.argv;

if (mode === "child") {
	setInterval(() => undefined, 60_000);
} else if (mode === "parent" && evidencePath) {
	const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "child"], {
		detached: false,
		stdio: "ignore"
	});
	if (child.pid === undefined) throw new Error("child fixture started without a pid");
	writeFileSync(
		evidencePath,
		JSON.stringify({ childPid: child.pid, parentPid: process.pid }),
		"utf8"
	);
	setInterval(() => undefined, 60_000);
} else {
	throw new Error("usage: owned-process-tree.mjs parent <evidence-path>");
}
