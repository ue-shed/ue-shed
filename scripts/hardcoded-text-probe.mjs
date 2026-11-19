// Measurement-only driver: requests and extracted records remain in pipes, never in files.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

process.env.RAYON_NUM_THREADS = "16";
process.env.CARGO_BUILD_JOBS = "8";
process.env.UE_SHED_UNREAL_LOCK = "E:\\es-id-repairs-scratch\\unreal.lock";
process.env.TEMP = "E:\\ue-shed-engine-scratch\\temp";
process.env.TMP = process.env.TEMP;

const mode = process.argv[2];
const output = resolve(process.argv[3] ?? "docs/engineering/hardcoded-text-probe");
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
	if (key.startsWith("UE_SHED_") && key !== "UE_SHED_UNREAL_LOCK") delete environment[key];
}

async function withProbeLock(run) {
	const path = process.env.UE_SHED_UNREAL_LOCK;
	const started = Date.now();
	let lastMessage = 0;
	let lease;
	for (;;) {
		try {
			lease = await open(path, "wx");
			break;
		} catch (cause) {
			if (cause?.code !== "EEXIST") throw cause;
			if (Date.now() - started >= 2 * 60 * 60 * 1000)
				throw new Error("Shared lock wait exceeded two hours");
			if (Date.now() - lastMessage >= 30_000) {
				process.stdout.write("Waiting for the shared heavy-job lock.\n");
				lastMessage = Date.now();
			}
			await setTimeout(1_000);
		}
	}
	try {
		await lease.writeFile(`Hardcoded probe ${new Date().toISOString()} pid ${process.pid}\n`);
		return await run();
	} finally {
		await lease.close();
		await unlink(path);
	}
}

function command(executable, args) {
	return new Promise((accept, reject) => {
		const child = spawn(executable, args, {
			env: environment,
			stdio: "inherit",
			windowsHide: true
		});
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0 ? accept() : reject(new Error("Check/build failed"))
		);
	});
}

async function extract(project, enabled) {
	const metrics = `${output}-${enabled ? "on" : "off"}.json`;
	const request = {
		contract: { name: "uasset-io", version: { major: 1, minor: 8 } },
		limits: { concurrency: 12, maximumOutputBytes: 64 * 1024 ** 3 },
		operation: { kind: "extract_text_packages", projectRoot: project, paths: ["Content"] },
		requestId: "hardcoded-text-probe"
	};
	const started = performance.now();
	const readerEnvironment = { ...environment, UE_SHED_HARDCODED_METRICS: metrics };
	if (enabled) readerEnvironment.UE_SHED_HARDCODED_PROBE = "1";
	const result = await new Promise((accept, reject) => {
		const child = spawn(resolve("target/release/uasset.exe"), ["protocol"], {
			env: readerEnvironment,
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true
		});
		process.stdout.write(`Reader pid ${child.pid}; probe ${enabled ? "on" : "off"}.\n`);
		let pending = "";
		let outcome;
		let summary;
		let decodeErrors = 0;
		let packageRecords = 0;
		let frames = 0;
		let bytes = 0;
		let invalid = false;
		const digest = createHash("sha256");
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			bytes += Buffer.byteLength(chunk);
			digest.update(chunk);
			pending += chunk;
			let end;
			while ((end = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				try {
					const frame = JSON.parse(line);
					frames++;
					if (frame.kind === "completed") outcome = frame.outcome;
					if (frame.kind === "failed" || frame.kind === "rejected") invalid = true;
					const event = frame.result?.event;
					if (event?.event === "text_package_record") {
						decodeErrors += event.decodeErrors;
						packageRecords++;
					}
					if (event?.event === "text_summary") {
						summary = {};
						for (const key of [
							"scannedAssets",
							"emittedAssets",
							"failedAssets",
							"partialAssets",
							"skippedAssets"
						])
							summary[key] = event[key];
					}
				} catch {
					invalid = true;
				}
			}
		});
		child.on("error", () => reject(new Error("Reader could not start")));
		child.on("close", (code) => {
			if (code !== 0 || invalid || !outcome || pending.trim() || !summary)
				reject(new Error("Reader did not produce a successful terminal frame and summary"));
			else
				accept({
					outcome,
					summary,
					decodeErrors,
					packageRecords,
					frames,
					bytes,
					digest: digest.digest("hex")
				});
		});
		child.stdin.on("error", () => {
			invalid = true;
		});
		child.stdin.end(JSON.stringify(request));
	});
	const report = JSON.parse(await readFile(metrics, "utf8"));
	report.transport = { ...result, wallSeconds: (performance.now() - started) / 1000 };
	await writeFile(metrics, JSON.stringify(report, null, 2) + "\n");
	process.stdout.write(
		JSON.stringify({
			mode,
			wall: report.wall_seconds,
			cpu: report.cpu_seconds,
			peakWorkingSet: report.peak_working_set_bytes,
			summary: result.summary
		}) + "\n"
	);
}

try {
	await withProbeLock(async () => {
		if (mode === "check") {
			await command("cargo", [
				"test",
				"--locked",
				"-p",
				"uasset-io",
				"--lib",
				"direct_executor::project_io::"
			]);
			await command("cargo", [
				"clippy",
				"--locked",
				"-p",
				"uasset-io",
				"--",
				"-D",
				"warnings"
			]);
		} else if (mode === "build") {
			await command("cargo", ["build", "--locked", "--release", "-p", "uasset-io"]);
		} else if (mode === "off" || mode === "on") {
			const source = await readFile("E:\\ue-shed-engine-scratch\\environment.ps1", "utf8");
			const match = source.match(/^\$env:BENCH_RELEASED_PROJECT\s*=\s*"([^"]+)"/m);
			if (!match) throw new Error("Released input is not configured");
			const project = /\.uproject$/i.test(match[1]) ? dirname(match[1]) : match[1];
			await extract(project, mode === "on");
		} else if (mode === "fixture") {
			await extract(resolve("fixtures/unreal-project"), true);
		} else throw new Error("Use check, build, off, on, or fixture");
	});
} catch {
	// Never echo an exception originating in a private project operation.
	process.stderr.write("Probe command failed; private diagnostics were suppressed.\n");
	process.exitCode = 1;
}
