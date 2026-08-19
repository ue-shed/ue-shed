import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , mode, evidencePath] = process.argv;

if (mode === "child") {
	setInterval(() => undefined, 60_000);
} else if ((mode === "parent" || mode === "parent-exits") && evidencePath) {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
		detached: false,
		stdio: "ignore"
	});
	if (child.pid === undefined) throw new Error("child fixture started without a pid");
	writeFileSync(
		evidencePath,
		JSON.stringify({ childPid: child.pid, parentPid: process.pid }),
		"utf8"
	);
	if (mode === "parent") setInterval(() => undefined, 60_000);
	else child.unref();
} else {
	throw new Error("usage: owned-process-tree.mjs parent|parent-exits <evidence-path>");
}
