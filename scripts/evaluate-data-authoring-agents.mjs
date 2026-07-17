import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "extensions", "data-authoring", "adoption.manifest.json");
const evaluationRoot = join(repositoryRoot, "test-results", "data-authoring-agent-eval");
const sourceKitRoot = join(evaluationRoot, "source-kit");
const cursorLauncher = join(process.env.LOCALAPPDATA ?? "", "cursor-agent", "cursor-agent.ps1");
const agents = {
	cursor: {
		command: "powershell.exe",
		args: (target, prompt) => [
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
			"cursor-grok-4.5-high",
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
		args: (target, prompt) => [
			"run",
			"--pure",
			"--model",
			"opencode-go/glm-5.2",
			"--format",
			"json",
			"--dir",
			target,
			"--title",
			"UE Shed Data Authoring adoption evaluation",
			prompt
		]
	},
	claude: {
		command: "claude.exe",
		args: (target, prompt) => [
			"--print",
			"--model",
			"sonnet",
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

function fail(message) {
	throw new Error(`Data Authoring agent evaluation failed: ${message}`);
}

function parseOptions() {
	const args = process.argv.slice(2);
	const verifyOnly = args[0] === "--verify-only";
	const selected = verifyOnly ? args.slice(1) : args;
	if (selected.length === 0 || selected.includes("all")) {
		return { selectedAgents: Object.keys(agents), verifyOnly };
	}
	for (const name of selected) {
		if (!(name in agents)) fail(`unknown agent '${name}'`);
	}
	return { selectedAgents: [...new Set(selected)], verifyOnly };
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, CI: "1", NO_COLOR: "1", ...options.env },
		maxBuffer: 32 * 1024 * 1024,
		shell: false,
		timeout: options.timeout ?? 15 * 60 * 1000,
		windowsHide: true
	});
	return {
		error: result.error?.message,
		status: result.status,
		stderr: result.stderr ?? "",
		stdout: result.stdout ?? ""
	};
}

function redactSecrets(value) {
	return value
		.replace(/(_authToken\s*=\s*)[^\\\r\n"]+/gi, "$1[REDACTED]")
		.replace(/\bnpm_[A-Za-z0-9]+\b/g, "[REDACTED_NPM_TOKEN]");
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

async function redactEvaluationLogs() {
	let entries;
	try {
		entries = await readdir(evaluationRoot, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !/-(?:stdout|stderr)\.log$/.test(entry.name)) continue;
		const path = join(evaluationRoot, entry.name);
		const original = await readFile(path, "utf8");
		const redacted = redactSecrets(original);
		if (redacted !== original) await writeFile(path, redacted);
	}
}

function runPnpm(args, options = {}) {
	return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, options);
}

async function copyEntry(entry) {
	const source = resolve(repositoryRoot, entry);
	const relativeSource = relative(repositoryRoot, source);
	if (relativeSource.startsWith("..")) fail(`copy entry escapes the repository: ${entry}`);
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
	await copyEntry("extensions/data-authoring/ADOPTING.md");
	await copyEntry("extensions/data-authoring/adoption.manifest.json");
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

Complete the adoption in the empty target:
1. Use the declared materializer to create the standalone consumer. Do not hand-copy unless it
   reports a concrete blocker.
2. Preserve the kernel-versus-owned boundary.
3. Pass source commit ${sourceCommit} to the materializer and preserve its generated provenance.
4. Render AuthoringRoute through EffectRuntimeProvider with the deterministic in-memory client.
5. Configure StyleX runtime injection for development and production stylex.css extraction.
6. Demonstrate adopter ownership by changing only the applied theme's colorAccent to #ff6b6b.
7. Install dependencies offline and run the target's exact portable verification command.
8. Write ADOPTION-REPORT.md with commands run, verification results, ambiguities, workarounds, and
   every file you needed that was not declared by the manifest.

Do not add Electron, Workbench, window.ueShed, Node types, filesystem authority, process authority,
or raw Unreal authority to browser code. Do not inspect environment variables, package-manager
configuration, credentials, or agent configuration. Work autonomously until the build passes or
you have documented a concrete blocker in ADOPTION-REPORT.md.`;
}

async function verifyTarget(name, target, sourceCommit) {
	const failures = [];
	const required = [
		"ADOPTION-REPORT.md",
		".ue-shed/data-authoring/adoption.manifest.json",
		"app/package.json",
		"app/src/index.tsx",
		"app/vite.config.ts",
		"scripts/verify-adoption.mjs",
		"ue-shed-provenance.json"
	];
	for (const entry of required) {
		try {
			await stat(join(target, entry));
		} catch {
			failures.push(`missing ${entry}`);
		}
	}

	const sourceFiles = await filesUnder(target);
	for (const path of sourceFiles) {
		if (!/\.(?:json|ts|tsx|js|mjs|css|html|yaml)$/i.test(path)) continue;
		const content = await readFile(path, "utf8");
		if (/apps[\\/]workbench|window\.ueShed|from ["']electron/.test(content)) {
			failures.push(`forbidden host authority in ${relative(target, path)}`);
		}
	}

	const provenancePath = join(target, "ue-shed-provenance.json");
	try {
		if (!(await readFile(provenancePath, "utf8")).includes(sourceCommit)) {
			failures.push("provenance does not contain the source commit");
		}
	} catch {}

	const reportPath = join(target, "ADOPTION-REPORT.md");
	try {
		const report = await readFile(reportPath, "utf8");
		if (!report.includes("pnpm verify -- --expected-accent=#ff6b6b")) {
			failures.push("adoption report omits the exact portable verification command");
		}
		if (/Replace this line|Record the exact materialize command/.test(report)) {
			failures.push("adoption report still contains template instructions");
		}
	} catch {}

	const themePath = join(target, "packages", "ui-theme", "src", "themes.stylex.ts");
	try {
		if (!(await readFile(themePath, "utf8")).includes("#ff6b6b")) {
			failures.push("owned accent token did not diverge to #ff6b6b");
		}
	} catch {
		failures.push("missing copied StyleX theme");
	}

	const install = runPnpm(
		["install", "--offline", "--ignore-scripts", "--frozen-lockfile=false"],
		{ cwd: target, timeout: 5 * 60 * 1000 }
	);
	await writeFile(
		join(evaluationRoot, `${name}-verify-install.log`),
		install.stdout + install.stderr
	);
	if (install.status !== 0) failures.push(`independent offline install exited ${install.status}`);

	const build = runPnpm(["verify", "--", "--expected-accent=#ff6b6b"], {
		cwd: target,
		timeout: 5 * 60 * 1000
	});
	await writeFile(join(evaluationRoot, `${name}-verify-build.log`), build.stdout + build.stderr);
	if (build.status !== 0) failures.push(`portable verifier exited ${build.status}`);

	const cssPath = join(target, "app", "dist", "stylex.css");
	try {
		const css = await readFile(cssPath, "utf8");
		if (css.length === 0) failures.push("production stylex.css is empty");
		if (!css.includes("#ff6b6b")) failures.push("production CSS does not contain #ff6b6b");
	} catch {
		failures.push("missing production stylex.css");
	}

	return { failures, passed: failures.length === 0 };
}

const { selectedAgents, verifyOnly } = parseOptions();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const commitResult = run("git.exe", ["rev-parse", "HEAD"]);
if (commitResult.status !== 0) fail("could not resolve the source commit");
const sourceCommit = verifyOnly
	? (await readFile(join(sourceKitRoot, "SOURCE_COMMIT"), "utf8")).trim()
	: commitResult.stdout.trim();
const initialStatus = run("git.exe", ["status", "--porcelain=v1", "--untracked-files=all"]);
if (initialStatus.status !== 0) fail("could not inspect repository status");

await redactEvaluationLogs();
if (!verifyOnly) await prepareSourceKit(manifest, sourceCommit);
await writeFile(join(evaluationRoot, "empty-npmrc"), "");
const pristineKitDigest = await treeDigest(sourceKitRoot);
const results = [];

for (const name of selectedAgents) {
	const target = join(evaluationRoot, "targets", name);
	const startedAt = Date.now();
	let agentDurationSeconds = 0;
	let execution = { error: undefined, status: undefined, stderr: "", stdout: "" };
	if (!verifyOnly) {
		await rm(target, { force: true, recursive: true });
		await mkdir(target, { recursive: true });
		const prompt = adoptionPrompt(target, sourceCommit);
		await writeFile(join(evaluationRoot, `${name}-prompt.md`), prompt);
		execution = run(agents[name].command, agents[name].args(target, prompt), {
			cwd: target,
			env: {
				NPM_CONFIG_USERCONFIG: join(evaluationRoot, "empty-npmrc"),
				NODE_AUTH_TOKEN: "",
				NPM_TOKEN: "",
				GH_TOKEN: "",
				GITHUB_TOKEN: "",
				AWS_ACCESS_KEY_ID: "",
				AWS_SECRET_ACCESS_KEY: "",
				AWS_SESSION_TOKEN: "",
				CLOUDFLARE_API_TOKEN: "",
				...agents[name].env
			}
		});
		agentDurationSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
		const attempt = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
		const findings = [...secretFindings(execution.stdout), ...secretFindings(execution.stderr)];
		await writeFile(
			join(evaluationRoot, `${name}-stdout.log`),
			redactSecrets(execution.stdout)
		);
		await writeFile(
			join(evaluationRoot, `${name}-stderr.log`),
			redactSecrets(execution.stderr)
		);
		await writeFile(
			join(evaluationRoot, `${name}-${attempt}-stdout.log`),
			redactSecrets(execution.stdout)
		);
		await writeFile(
			join(evaluationRoot, `${name}-${attempt}-stderr.log`),
			redactSecrets(execution.stderr)
		);
		execution.secretFindings = [...new Set(findings)];
	}
	const verificationStartedAt = Date.now();
	const verification = await verifyTarget(name, target, sourceCommit);
	if (execution.secretFindings?.length) {
		verification.failures.push(
			`agent output contained secrets: ${execution.secretFindings.join(", ")}`
		);
	}
	const kitUnchanged = (await treeDigest(sourceKitRoot)) === pristineKitDigest;
	if (!kitUnchanged) verification.failures.push("agent modified the restricted source kit");
	verification.passed = verification.failures.length === 0;
	results.push({
		agent: name,
		agentDurationSeconds,
		durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
		executionError: execution.error,
		executionStatus: execution.status,
		kitUnchanged,
		verificationDurationSeconds: Math.round((Date.now() - verificationStartedAt) / 100) / 10,
		...verification
	});
	await writeFile(
		join(evaluationRoot, `${name}-evaluation.json`),
		`${JSON.stringify(results.at(-1), null, 2)}\n`
	);
}

const finalStatus = run("git.exe", ["status", "--porcelain=v1", "--untracked-files=all"]);
const repositoryUnchanged = finalStatus.stdout === initialStatus.stdout;
const report = { repositoryUnchanged, sourceCommit, results };
await writeFile(
	join(evaluationRoot, "evaluation-report.json"),
	`${JSON.stringify(report, null, 2)}\n`
);
console.log(JSON.stringify(report, null, 2));

if (!repositoryUnchanged) fail("an agent changed the UE Shed repository");
if (results.some((result) => (!verifyOnly && result.executionStatus !== 0) || !result.passed)) {
	process.exitCode = 1;
}
