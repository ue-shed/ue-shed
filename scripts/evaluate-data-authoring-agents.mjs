import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "extensions", "data-authoring", "adoption.manifest.json");
const evidenceRoot = join(repositoryRoot, "test-results", "data-authoring-agent-eval");
const cursorLauncher = join(process.env.LOCALAPPDATA ?? "", "cursor-agent", "cursor-agent.ps1");
const defaultModels = {
	claude: "sonnet",
	cursor: "cursor-grok-4.5-high",
	opencode: "opencode-go/glm-5.2"
};

function fail(message) {
	throw new Error(`Data Authoring agent evaluation failed: ${message}`);
}

function readFlag(args, index) {
	const [name, inline] = args[index].split("=", 2);
	if (inline !== undefined) return { consumed: 1, name, value: inline };
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${name} requires a value`);
	return { consumed: 2, name, value };
}

function parseOptions() {
	const args = process.argv.slice(2);
	const positional = [];
	const flags = {};
	let verifyOnly = false;
	for (let index = 0; index < args.length; ) {
		const argument = args[index];
		if (argument === "--verify-only") {
			verifyOnly = true;
			index += 1;
			continue;
		}
		if (!argument.startsWith("--")) {
			positional.push(argument);
			index += 1;
			continue;
		}
		const flag = readFlag(args, index);
		if (
			!["--label", "--model", "--timeout-seconds", "--variant", "--workspace-root"].includes(
				flag.name
			)
		) {
			fail(`unknown option '${flag.name}'`);
		}
		flags[flag.name.slice(2)] = flag.value;
		index += flag.consumed;
	}

	const knownAgents = Object.keys(defaultModels);
	const selectedAgents =
		positional.length === 0 || positional.includes("all") ? knownAgents : positional;
	for (const name of selectedAgents) {
		if (!(name in defaultModels)) fail(`unknown agent '${name}'`);
	}
	const uniqueAgents = [...new Set(selectedAgents)];
	if ((flags.model || flags.variant || flags.label) && uniqueAgents.length !== 1) {
		fail("--model, --variant, and --label require exactly one selected agent");
	}
	const timeoutSeconds = Number(flags["timeout-seconds"] ?? 900);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		fail("--timeout-seconds must be a positive number");
	}
	const label = flags.label ?? uniqueAgents[0];
	if (label && !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
		fail("--label may contain only letters, numbers, dots, underscores, and hyphens");
	}
	return {
		label,
		model: flags.model,
		selectedAgents: uniqueAgents,
		timeoutMs: timeoutSeconds * 1000,
		variant: flags.variant,
		verifyOnly,
		workspaceRoot: resolve(
			flags["workspace-root"] ?? join(tmpdir(), "ue-shed-data-authoring-agent-eval")
		)
	};
}

const options = parseOptions();
const workspaceRoot = options.workspaceRoot;
const sourceKitRoot = join(workspaceRoot, "source-kit");
const emptyNpmConfig = join(evidenceRoot, "empty-npmrc");

const agents = {
	cursor: {
		command: "powershell.exe",
		args: ({ model, prompt, target }) => [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			cursorLauncher,
			"--print",
			"--workspace",
			target,
			"--add-dir",
			sourceKitRoot,
			"--model",
			model,
			"--output-format",
			"json",
			"--sandbox",
			"disabled",
			"--trust",
			"--force",
			prompt
		]
	},
	opencode: {
		command: "opencode.exe",
		env: {
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				permission: {
					external_directory: "allow",
					task: "deny",
					webfetch: "deny",
					websearch: "deny"
				}
			})
		},
		args: ({ label, model, prompt, target, variant }) => [
			"run",
			"--pure",
			"--model",
			model,
			...(variant ? ["--variant", variant] : []),
			"--format",
			"json",
			"--dir",
			target,
			"--title",
			`UE Shed Data Authoring adoption evaluation - ${label}`,
			prompt
		]
	},
	claude: {
		command: "claude.exe",
		args: ({ model, prompt }) => [
			"--print",
			"--model",
			model,
			"--safe-mode",
			"--no-session-persistence",
			"--output-format",
			"json",
			"--permission-mode",
			"dontAsk",
			"--tools",
			"Read,Write,Edit,Bash",
			"--allowedTools",
			"Read,Write,Edit,Bash",
			"--add-dir",
			sourceKitRoot,
			"--max-budget-usd",
			"10",
			"--system-prompt",
			"Work only in the current target and the explicitly supplied source kit. " +
				"Do not inspect or modify the original UE Shed repository.",
			prompt
		]
	}
};

function credentialHostileEnvironment(extra = {}) {
	return {
		...process.env,
		AWS_ACCESS_KEY_ID: "",
		AWS_SECRET_ACCESS_KEY: "",
		AWS_SESSION_TOKEN: "",
		CI: "1",
		CLOUDFLARE_API_TOKEN: "",
		GH_TOKEN: "",
		GITHUB_TOKEN: "",
		NODE_AUTH_TOKEN: "",
		NO_COLOR: "1",
		NPM_CONFIG_USERCONFIG: emptyNpmConfig,
		NPM_TOKEN: "",
		...extra
	};
}

function run(command, args, runOptions = {}) {
	const result = spawnSync(command, args, {
		cwd: runOptions.cwd ?? repositoryRoot,
		encoding: "utf8",
		env: credentialHostileEnvironment(runOptions.env),
		maxBuffer: 32 * 1024 * 1024,
		shell: false,
		timeout: runOptions.timeout ?? 15 * 60 * 1000,
		windowsHide: true
	});
	return {
		error: result.error?.message,
		status: result.status,
		stderr: result.stderr ?? "",
		stdout: result.stdout ?? "",
		timedOut: result.error?.code === "ETIMEDOUT"
	};
}

function terminateProcessTree(pid) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true
		});
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
}

function redactSecrets(value) {
	return value
		.replace(/(_authToken\s*=\s*)[^\\\r\n"]+/gi, "$1[REDACTED]")
		.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]")
		.replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED_GITHUB_TOKEN]");
}

function secretFindings(value) {
	const findings = [];
	if (/(_authToken\s*=\s*)[^\\\r\n"]+/i.test(value)) findings.push("npm auth token assignment");
	if (/\bnpm_[A-Za-z0-9]{20,}\b/.test(value)) findings.push("npm token-shaped value");
	if (/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/i.test(value)) {
		findings.push("GitHub token-shaped value");
	}
	return findings;
}

async function runAgent({ agent, args, label, target, timeoutMs }) {
	const latestStdout = join(evidenceRoot, `${label}-stdout.log`);
	const latestStderr = join(evidenceRoot, `${label}-stderr.log`);
	const launchRoot = join(workspaceRoot, "launches");
	await mkdir(launchRoot, { recursive: true });
	const rawStdout = join(launchRoot, `${label}-stdout.raw.log`);
	const rawStderr = join(launchRoot, `${label}-stderr.raw.log`);
	const configPath = join(launchRoot, `${label}.json`);
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				arguments: [...args],
				command: agent.command,
				cwd: target,
				stderrPath: rawStderr,
				stdoutPath: rawStdout
			},
			null,
			2
		)}\n`
	);
	let spawnError;
	let timedOut = false;
	const child = spawn(
		process.platform === "win32" ? "pwsh.exe" : "pwsh",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			join(repositoryRoot, "scripts", "run-agent-process.ps1"),
			"-ConfigPath",
			configPath
		],
		{
			cwd: repositoryRoot,
			detached: process.platform !== "win32",
			env: credentialHostileEnvironment(agent.env),
			shell: false,
			stdio: "ignore",
			windowsHide: true
		}
	);
	child.on("error", (error) => {
		spawnError = error;
	});
	const timer = setTimeout(() => {
		timedOut = true;
		terminateProcessTree(child.pid);
	}, timeoutMs);
	const status = await new Promise((resolveStatus) => {
		child.on("close", (code) => resolveStatus(code));
	});
	clearTimeout(timer);
	let stdout = "";
	let stderr = "";
	try {
		stdout = await readFile(rawStdout, "utf8");
	} catch {}
	try {
		stderr = await readFile(rawStderr, "utf8");
	} catch {}
	await writeFile(latestStdout, redactSecrets(stdout));
	await writeFile(latestStderr, redactSecrets(stderr));
	const attempt = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	await copyFile(latestStdout, join(evidenceRoot, `${label}-${attempt}-stdout.log`));
	await copyFile(latestStderr, join(evidenceRoot, `${label}-${attempt}-stderr.log`));
	await Promise.all([
		rm(configPath, { force: true }),
		rm(rawStdout, { force: true }),
		rm(rawStderr, { force: true })
	]);
	return {
		error: timedOut ? `timed out after ${timeoutMs / 1000} seconds` : spawnError?.message,
		secretFindings: [...new Set([...secretFindings(stdout), ...secretFindings(stderr)])],
		status,
		stderr,
		stdout,
		timedOut
	};
}

function runPnpm(args, runOptions = {}) {
	return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, runOptions);
}

async function copyEntry(entry) {
	const source = resolve(repositoryRoot, entry);
	if (relative(repositoryRoot, source).startsWith(".."))
		fail(`copy entry escapes repository: ${entry}`);
	const destination = join(sourceKitRoot, entry);
	await mkdir(dirname(destination), { recursive: true });
	await cp(source, destination, { recursive: (await stat(source)).isDirectory() });
}

async function filesUnder(root) {
	const entries = await readdir(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (["node_modules", "dist"].includes(entry.name)) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(path)));
		else files.push(path);
	}
	return files.sort();
}

async function treeDigest(root) {
	const hash = createHash("sha256");
	for (const path of await filesUnder(root)) {
		hash.update(relative(root, path).replaceAll("\\", "/"));
		hash.update(await readFile(path));
	}
	return hash.digest("hex");
}

async function prepareSourceKit(manifest, sourceCommit) {
	await rm(sourceKitRoot, { force: true, recursive: true });
	await mkdir(sourceKitRoot, { recursive: true });
	for (const entry of manifest.kit.entrypoints) await copyEntry(entry);
	await copyEntry(manifest.materialize.script);
	await copyEntry(manifest.provenance.schema);
	await copyEntry(manifest.provenance.template);
	await copyEntry(manifest.consumerTemplate);
	for (const entry of [...manifest.copy.kernel, ...manifest.copy.owned]) await copyEntry(entry);
	await writeFile(join(sourceKitRoot, "SOURCE_COMMIT"), `${sourceCommit}\n`);
}

function adoptionPrompt(target, sourceCommit) {
	const guide = join(sourceKitRoot, "extensions", "data-authoring", "ADOPTING.md");
	const manifest = join(sourceKitRoot, "extensions", "data-authoring", "adoption.manifest.json");
	return `You are performing a clean-room adoption evaluation of UE Shed's Data Authoring slice.

Your empty target directory is:
${target}

The restricted read-only source kit is:
${sourceKitRoot}

Start by reading only these adoption entrypoints:
- ${guide}
- ${manifest}

Treat the manifest as the source of truth. Do not inspect or modify the original UE Shed repository,
any Workbench code, another agent's target, or a pre-generated adoption result.

Follow the guide's first-pass fast path. Run the materializer, change only the applied theme's
colorAccent to #ff6b6b, install offline, and run the exact target verifier. Do not enumerate the
template, inspect generated implementation files other than the theme, guess alternate paths, or run
Git commands unless a command fails and names a file to inspect.

Preserve the kernel-versus-owned boundary and source commit ${sourceCommit}. Keep the generated
ADOPTION-REPORT.md under 500 words with exact commands, results, ambiguities, workarounds, and every
undeclared input used.

Do not add Electron, Workbench, window.ueShed, Node types, filesystem authority, process authority,
or raw Unreal authority to browser code. Do not inspect environment variables, package-manager
configuration, credentials, agent configuration, or any parent Git worktree. Work autonomously until
verification passes or the report documents a concrete blocker.`;
}

function parseAgentMetrics(stdout) {
	const metrics = { toolCalls: 0, tools: {} };
	let rows = [];
	try {
		rows = stdout
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		try {
			rows = [JSON.parse(stdout)];
		} catch {
			return metrics;
		}
	}
	for (const row of rows) {
		if (row.type === "tool_use") {
			metrics.toolCalls += 1;
			const tool = row.part?.tool ?? "unknown";
			metrics.tools[tool] = (metrics.tools[tool] ?? 0) + 1;
		}
		if (row.type === "step_finish") {
			metrics.inputTokens = (metrics.inputTokens ?? 0) + (row.part?.tokens?.input ?? 0);
			metrics.outputTokens = (metrics.outputTokens ?? 0) + (row.part?.tokens?.output ?? 0);
			metrics.reasoningTokens =
				(metrics.reasoningTokens ?? 0) + (row.part?.tokens?.reasoning ?? 0);
			metrics.reportedCostUsd = (metrics.reportedCostUsd ?? 0) + (row.part?.cost ?? 0);
			metrics.steps = (metrics.steps ?? 0) + 1;
		}
		if (row.num_turns !== undefined) metrics.turns = row.num_turns;
		if (row.total_cost_usd !== undefined) metrics.reportedCostUsd = row.total_cost_usd;
		if (row.usage?.output_tokens !== undefined) metrics.outputTokens = row.usage.output_tokens;
		if (row.usage?.input_tokens !== undefined) metrics.inputTokens = row.usage.input_tokens;
	}
	if (metrics.reportedCostUsd !== undefined) {
		metrics.reportedCostUsd = Math.round(metrics.reportedCostUsd * 10_000) / 10_000;
	}
	return metrics;
}

async function materializeBaseline(sourceCommit) {
	const baseline = join(workspaceRoot, "baseline");
	await rm(baseline, { force: true, recursive: true });
	const result = run(
		process.execPath,
		[
			join(sourceKitRoot, "extensions", "data-authoring", "adoption", "materialize.mjs"),
			"--target",
			baseline,
			"--source-commit",
			sourceCommit
		],
		{ cwd: workspaceRoot }
	);
	if (result.status !== 0) fail(`could not materialize comparison baseline: ${result.stderr}`);
	return baseline;
}

async function fileDigestMap(root) {
	const map = new Map();
	for (const path of await filesUnder(root)) {
		map.set(
			relative(root, path).replaceAll("\\", "/"),
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex")
		);
	}
	return map;
}

async function compareWithBaseline(target, baseline) {
	const expectedChanged = new Set([
		"ADOPTION-REPORT.md",
		"packages/ui-theme/src/themes.stylex.ts"
	]);
	const expectedExtra = new Set(["pnpm-lock.yaml"]);
	const [baselineFiles, targetFiles] = await Promise.all([
		fileDigestMap(baseline),
		fileDigestMap(target)
	]);
	const names = [...new Set([...baselineFiles.keys(), ...targetFiles.keys()])].sort();
	const changed = names.filter(
		(name) =>
			baselineFiles.has(name) &&
			targetFiles.has(name) &&
			baselineFiles.get(name) !== targetFiles.get(name)
	);
	const extra = names.filter((name) => !baselineFiles.has(name) && targetFiles.has(name));
	const missing = names.filter((name) => baselineFiles.has(name) && !targetFiles.has(name));
	return {
		changed,
		extra,
		missing,
		unexpectedChanged: changed.filter((name) => !expectedChanged.has(name)),
		unexpectedExtra: extra.filter((name) => !expectedExtra.has(name))
	};
}

async function verifyTarget(label, target, sourceCommit, baseline) {
	const failures = [];
	for (const entry of [
		"ADOPTION-REPORT.md",
		".ue-shed/data-authoring/adoption.manifest.json",
		"app/package.json",
		"app/src/index.tsx",
		"app/vite.config.ts",
		"scripts/verify-adoption.mjs",
		"ue-shed-provenance.json"
	]) {
		try {
			await stat(join(target, entry));
		} catch {
			failures.push(`missing ${entry}`);
		}
	}

	for (const path of await filesUnder(target)) {
		if (!/\.(?:json|ts|tsx|js|mjs|css|html|yaml)$/i.test(path)) continue;
		const content = await readFile(path, "utf8");
		if (/apps[\\/]workbench|window\.ueShed|from ["']electron/.test(content)) {
			failures.push(`forbidden host authority in ${relative(target, path)}`);
		}
	}

	try {
		if (
			!(await readFile(join(target, "ue-shed-provenance.json"), "utf8")).includes(
				sourceCommit
			)
		) {
			failures.push("provenance does not contain the source commit");
		}
	} catch {}

	let reportWordCount;
	try {
		const report = await readFile(join(target, "ADOPTION-REPORT.md"), "utf8");
		reportWordCount = report.trim().split(/\s+/).length;
		if (!report.includes("pnpm verify -- --expected-accent=#ff6b6b")) {
			failures.push("adoption report omits exact portable verification command");
		}
		if (/Replace this line|Record the exact materialize command/.test(report)) {
			failures.push("adoption report still contains template instructions");
		}
	} catch {}

	try {
		if (
			!(
				await readFile(
					join(target, "packages", "ui-theme", "src", "themes.stylex.ts"),
					"utf8"
				)
			).includes("#ff6b6b")
		) {
			failures.push("owned accent token did not diverge to #ff6b6b");
		}
	} catch {
		failures.push("missing copied StyleX theme");
	}

	const seedInstall = runPnpm(["install", "--ignore-scripts", "--frozen-lockfile=false"], {
		cwd: target,
		timeout: 5 * 60 * 1000
	});
	await writeFile(
		join(evidenceRoot, `${label}-verify-install-seed.log`),
		seedInstall.stdout + seedInstall.stderr
	);
	if (seedInstall.status !== 0) {
		failures.push(`independent install seed exited ${seedInstall.status}`);
	} else {
		await rm(join(target, "node_modules"), { recursive: true, force: true });
		const install = runPnpm(["install", "--offline", "--ignore-scripts", "--frozen-lockfile"], {
			cwd: target,
			timeout: 5 * 60 * 1000
		});
		await writeFile(
			join(evidenceRoot, `${label}-verify-install.log`),
			install.stdout + install.stderr
		);
		if (install.status !== 0)
			failures.push(`independent offline install exited ${install.status}`);
	}

	const verifier = runPnpm(["verify", "--", "--expected-accent=#ff6b6b"], {
		cwd: target,
		timeout: 5 * 60 * 1000
	});
	await writeFile(
		join(evidenceRoot, `${label}-verify-build.log`),
		verifier.stdout + verifier.stderr
	);
	if (verifier.status !== 0) failures.push(`portable verifier exited ${verifier.status}`);

	try {
		const css = await readFile(join(target, "app", "dist", "stylex.css"), "utf8");
		if (css.length === 0) failures.push("production stylex.css is empty");
		if (!css.includes("#ff6b6b")) failures.push("production CSS does not contain #ff6b6b");
	} catch {
		failures.push("missing production stylex.css");
	}

	const artifactDiff = await compareWithBaseline(target, baseline);
	if (artifactDiff.missing.length)
		failures.push(`baseline files missing: ${artifactDiff.missing.join(", ")}`);
	if (artifactDiff.unexpectedChanged.length) {
		failures.push(`unexpected changed files: ${artifactDiff.unexpectedChanged.join(", ")}`);
	}
	if (artifactDiff.unexpectedExtra.length) {
		failures.push(`unexpected extra files: ${artifactDiff.unexpectedExtra.join(", ")}`);
	}
	return { artifactDiff, failures, passed: failures.length === 0, reportWordCount };
}

await mkdir(evidenceRoot, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await writeFile(emptyNpmConfig, "");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.kit?.entrypoints) || manifest.kit.entrypoints.length !== 2) {
	fail("manifest must declare exactly two kit entrypoints");
}
const commitResult = run("git.exe", ["rev-parse", "HEAD"]);
if (commitResult.status !== 0) fail("could not resolve source commit");
const sourceCommit = options.verifyOnly
	? (await readFile(join(sourceKitRoot, "SOURCE_COMMIT"), "utf8")).trim()
	: commitResult.stdout.trim();
const initialStatus = run("git.exe", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (initialStatus.status !== 0) fail("could not inspect repository status");

if (!options.verifyOnly) await prepareSourceKit(manifest, sourceCommit);
const pristineKitDigest = await treeDigest(sourceKitRoot);
const baseline = await materializeBaseline(sourceCommit);
const results = [];

for (const agentName of options.selectedAgents) {
	const label = options.selectedAgents.length === 1 ? options.label : agentName;
	const model =
		options.selectedAgents.length === 1 && options.model
			? options.model
			: defaultModels[agentName];
	const target = join(workspaceRoot, "targets", label);
	const startedAt = Date.now();
	let execution = {
		error: undefined,
		secretFindings: [],
		status: undefined,
		stderr: "",
		stdout: "",
		timedOut: false
	};
	let agentDurationSeconds = 0;
	if (!options.verifyOnly) {
		await rm(target, { force: true, recursive: true });
		await mkdir(target, { recursive: true });
		const prompt = adoptionPrompt(target, sourceCommit);
		await writeFile(join(evidenceRoot, `${label}-prompt.md`), prompt);
		const agent = agents[agentName];
		const args = agent.args({ label, model, prompt, target, variant: options.variant });
		execution = await runAgent({
			agent,
			args,
			label,
			target,
			timeoutMs: options.timeoutMs
		});
		agentDurationSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
	}

	const verificationStartedAt = Date.now();
	const verification = await verifyTarget(label, target, sourceCommit, baseline);
	if (execution.secretFindings.length) {
		verification.failures.push(
			`agent output contained secrets: ${execution.secretFindings.join(", ")}`
		);
	}
	const kitUnchanged = (await treeDigest(sourceKitRoot)) === pristineKitDigest;
	if (!kitUnchanged) verification.failures.push("agent modified restricted source kit");
	verification.passed = verification.failures.length === 0;
	const result = {
		agent: agentName,
		agentDurationSeconds,
		durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
		executionError: execution.error,
		executionStatus: execution.status,
		kitUnchanged,
		label,
		metrics: parseAgentMetrics(execution.stdout),
		model,
		timedOut: execution.timedOut,
		variant: options.variant,
		verificationDurationSeconds: Math.round((Date.now() - verificationStartedAt) / 100) / 10,
		...verification
	};
	results.push(result);
	await writeFile(
		join(evidenceRoot, `${label}-evaluation.json`),
		`${JSON.stringify(result, null, 2)}\n`
	);
}

const finalStatus = run("git.exe", ["status", "--porcelain=v1", "--untracked-files=all"]);
const repositoryUnchanged = finalStatus.stdout === initialStatus.stdout;
const report = { repositoryUnchanged, sourceCommit, workspaceRoot, results };
await writeFile(
	join(evidenceRoot, "evaluation-report.json"),
	`${JSON.stringify(report, null, 2)}\n`
);
console.log(JSON.stringify(report, null, 2));

if (!repositoryUnchanged) fail("an agent changed UE Shed repository");
if (
	results.some(
		(result) => (!options.verifyOnly && result.executionStatus !== 0) || !result.passed
	)
) {
	process.exitCode = 1;
}
