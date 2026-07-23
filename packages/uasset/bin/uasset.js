#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolveUassetExecutable } from "../src/index.js";

try {
	const executable = resolveUassetExecutable();
	const result = spawnSync(executable, process.argv.slice(2), {
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error !== undefined) throw result.error;
	if (result.signal !== null) {
		process.stderr.write(`uasset terminated by signal ${result.signal}\n`);
		process.exitCode = 1;
	} else {
		process.exitCode = result.status ?? 1;
	}
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	process.stderr.write(`uasset: ${message}\n`);
	process.exitCode = 1;
}
