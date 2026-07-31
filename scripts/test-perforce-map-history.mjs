import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdtemp,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.mjs";

const perforceRelease = "r26.1";
const perforceDownloadRoot = `https://ftp.perforce.com/perforce/${perforceRelease}`;
const fixtureRoot = join(repositoryRoot, "fixtures", "perforce-map-history");
const fixtureDepot = "ue-shed-map-history";
const fixtureUser = "ue-shed-map-history";
const fixtureClient = "ue-shed-map-history-client";
const configFileName = ".ue-shed-map-history-p4config";
const p4TimeoutMs = 30_000;

const platformBinaries = {
	darwin: {
		directory: "bin.darwin90x86_64",
		p4: {
			name: "p4",
			sha256: "a539b30d5b6ee80685bfb691b17e6c1ef50bfcaa9f1c6c7034301f423ab1224f"
		},
		p4d: {
			name: "p4d",
			sha256: "cfc32bbbe57476fcdd4ff9d0f49ae429e91d46751a16c99dd5ec4c7123882474"
		}
	},
	linux: {
		directory: "bin.linux26x86_64",
		p4: {
			name: "p4",
			sha256: "a539b30d5b6ee80685bfb691b17e6c1ef50bfcaa9f1c6c7034301f423ab1224f"
		},
		p4d: {
			name: "p4d",
			sha256: "cfc32bbbe57476fcdd4ff9d0f49ae429e91d46751a16c99dd5ec4c7123882474"
		}
	},
	win32: {
		directory: "bin.ntx64",
		p4: {
			name: "p4.exe",
			sha256: "1fe2730acda5df7dee244aa4d22d6dfe3698176a2d127eb801ba94a9cf41d9b4"
		},
		p4d: {
			name: "p4d.exe",
			sha256: "025b87752de37047ed1398f31b88c6f6c6d62086e74ca6600fc1617fd24f22e1"
		}
	}
};

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function report(status, message) {
	process.stdout.write(`${status} Perforce Map History: ${message}\n`);
}

function p4Environment(overrides = {}) {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.toUpperCase().startsWith("P4")) delete environment[key];
	}
	return { ...environment, ...overrides };
}

function cacheRoot() {
	const configured = process.env.UE_SHED_PERFORCE_MAP_HISTORY_BINARY_CACHE;
	if (configured) return resolve(configured);
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? tmpdir(), "UE-Shed", "perforce");
	}
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ue-shed", "perforce");
}

async function sha256(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function cachePinnedBinary(directory, binary) {
	const destinationDirectory = join(cacheRoot(), perforceRelease, directory);
	const destination = join(destinationDirectory, binary.name);
	await mkdir(destinationDirectory, { recursive: true });
	try {
		await access(destination);
		const actual = await sha256(destination);
		assert(
			actual === binary.sha256,
			`Cached ${binary.name} does not match the pinned SHA-256. Remove ${destination} and retry.`
		);
		report("RUN ", `using hash-verified cached ${binary.name}`);
		return destination;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			// Download below.
		} else {
			throw error;
		}
	}

	const url = `${perforceDownloadRoot}/${directory}/${binary.name}`;
	const partial = join(destinationDirectory, `${binary.name}.${process.pid}.partial`);
	report("RUN ", `downloading pinned ${binary.name} from Perforce`);
	const response = await fetch(url);
	assert(response.ok, `Could not download ${url}: ${response.status} ${response.statusText}`);
	await writeFile(partial, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
	try {
		const actual = await sha256(partial);
		assert(
			actual === binary.sha256,
			`Downloaded ${binary.name} did not match its pinned SHA-256 (${actual}).`
		);
		await rename(partial, destination);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	if (process.platform !== "win32") await chmod(destination, 0o755);
	return destination;
}

async function resolveBinaries() {
	const configuredP4 = process.env.UE_SHED_PERFORCE_MAP_HISTORY_P4_EXECUTABLE;
	const configuredP4d = process.env.UE_SHED_PERFORCE_MAP_HISTORY_P4D_EXECUTABLE;
	if (configuredP4 || configuredP4d) {
		assert(
			configuredP4 && configuredP4d,
			"Set both UE_SHED_PERFORCE_MAP_HISTORY_P4_EXECUTABLE and UE_SHED_PERFORCE_MAP_HISTORY_P4D_EXECUTABLE."
		);
		await Promise.all([access(configuredP4), access(configuredP4d)]);
		report("RUN ", "using explicitly configured isolated p4 and p4d binaries");
		return { p4: configuredP4, p4d: configuredP4d };
	}
	const platform = platformBinaries[process.platform];
	assert(
		platform !== undefined,
		`No pinned Perforce binary pair is configured for ${process.platform}. Set both explicit binary paths.`
	);
	return {
		p4: await cachePinnedBinary(platform.directory, platform.p4),
		p4d: await cachePinnedBinary(platform.directory, platform.p4d)
	};
}

function run(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? p4TimeoutMs);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timeout);
			const result = {
				exitCode: exitCode ?? -1,
				signal,
				stderr: Buffer.concat(stderr).toString("utf8"),
				stdout: Buffer.concat(stdout).toString("utf8")
			};
			if (result.exitCode === 0) resolvePromise(result);
			else {
				reject(
					new Error(
						`${basename(command)} ${(options.displayArgs ?? args).join(" ")} failed with ${result.exitCode}${
							signal ? ` (${signal})` : ""
						}: ${result.stderr || result.stdout}`
					)
				);
			}
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}

async function waitForProcessExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((resolvePromise) => {
		const timeout = setTimeout(resolvePromise, 5_000);
		child.once("close", () => {
			clearTimeout(timeout);
			resolvePromise();
		});
	});
}

async function getAvailablePort() {
	const net = await import("node:net");
	return new Promise((resolvePromise, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(
					new Error("Could not reserve a localhost port for the disposable p4d server.")
				);
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
		});
	});
}

function wait(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForServer(p4, environment, cwd) {
	let lastError;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await run(p4, ["info"], { cwd, env: environment, timeoutMs: 1_000 });
			return;
		} catch (error) {
			lastError = error;
			await wait(100);
		}
	}
	throw new Error("The disposable p4d server did not become ready.", { cause: lastError });
}

function validateFixturePath(path) {
	assert(typeof path === "string" && path.length > 0, "Fixture revision path must be non-empty.");
	assert(!isAbsolute(path), `Fixture revision path must be project-relative: ${path}`);
	const normalized = resolve("fixture-root", path);
	assert(
		relative("fixture-root", normalized) !== "",
		`Fixture revision path must name a file: ${path}`
	);
	assert(
		!relative("fixture-root", normalized).startsWith(`..${sep}`),
		`Fixture revision escapes its root: ${path}`
	);
	return path;
}

function loadScenario(fileName) {
	const scenario = JSON.parse(requireText(join(fixtureRoot, fileName)));
	assert(Array.isArray(scenario.revisions), `${fileName} must declare revisions.`);
	for (const revision of scenario.revisions) {
		assert(
			typeof revision?.id === "string" && revision.id.length > 0,
			"Fixture revision needs an id."
		);
		assert(Array.isArray(revision.files), `Fixture revision ${revision.id} needs files.`);
		for (const file of revision.files) {
			assert(["add", "edit", "delete"].includes(file?.action), `Unsupported fixture action.`);
			validateFixturePath(file.path);
		}
	}
	return scenario;
}

function requireText(path) {
	return readFileSync(path, "utf8");
}

function workspacePath(workspace, projectRelativePath) {
	const path = resolve(workspace, validateFixturePath(projectRelativePath));
	const contained = relative(workspace, path);
	assert(
		contained.length > 0 &&
			contained !== ".." &&
			!contained.startsWith(`..${sep}`) &&
			!isAbsolute(contained),
		`Fixture path escapes the disposable workspace: ${projectRelativePath}`
	);
	return path;
}

async function latestSubmittedChange(p4, environment, cwd) {
	const result = await run(p4, ["-Mj", "-z", "tag", "changes", "-s", "submitted", "-m", "1"], {
		cwd,
		env: environment
	});
	const row = result.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line))[0];
	assert(row !== undefined, "Perforce did not return the submitted fixture changelist.");
	const change = Number(row.change);
	const submittedAtSeconds = Number(row.time);
	assert(
		Number.isInteger(change) && change > 0,
		"Perforce returned an invalid submitted change number."
	);
	assert(
		Number.isInteger(submittedAtSeconds) && submittedAtSeconds > 0,
		"Perforce returned an invalid submitted change time."
	);
	return { change, submittedAtSeconds };
}

async function submitFixtureRevision({ p4, environment, revision, workspace }) {
	for (const file of revision.files) {
		const target = workspacePath(workspace, file.path);
		if (file.action === "delete") {
			await run(p4, ["delete", target], { cwd: workspace, env: environment });
			continue;
		}
		const source = resolve(
			fixtureRoot,
			"revisions",
			revision.id,
			validateFixturePath(file.path)
		);
		await access(source);
		await mkdir(dirname(target), { recursive: true });
		if (file.action === "add") {
			await copyFile(source, target);
			await run(p4, ["add", "-t", "binary", target], { cwd: workspace, env: environment });
			continue;
		}
		await run(p4, ["edit", target], { cwd: workspace, env: environment });
		await copyFile(source, target);
	}
	await run(p4, ["submit", "-d", `Map History fixture: ${revision.id}`], {
		cwd: workspace,
		env: environment
	});
	return latestSubmittedChange(p4, environment, workspace);
}

async function advancePast(second) {
	while (Math.floor(Date.now() / 1_000) <= second) await wait(25);
}

async function createClient(p4, environment, workspace) {
	const specification = [
		`Client: ${fixtureClient}`,
		`Owner: ${fixtureUser}`,
		`Root: ${workspace}`,
		"Options: noallwrite noclobber nocompress unlocked nomodtime rmdir",
		"LineEnd: local",
		"View:",
		`\t//${fixtureDepot}/... //${fixtureClient}/...`,
		""
	].join("\n");
	await run(p4, ["client", "-i"], { cwd: workspace, env: environment, input: specification });
}

async function createDepot(p4, environment, cwd) {
	const specification = [
		`Depot: ${fixtureDepot}`,
		`Owner: ${fixtureUser}`,
		"Description:",
		"\tDisposable UE Shed Map History conformance depot.",
		"Type: local",
		"Address: local",
		`Map: ${fixtureDepot}/...`,
		""
	].join("\n");
	await run(p4, ["depot", "-i"], { cwd, env: environment, input: specification });
}

async function seedFixture({ p4, environment, workspace }) {
	const conventional = loadScenario("conventional-scenario.json");
	const worldPartition = loadScenario("scenario.json");
	const conventionalBaseline = await submitFixtureRevision({
		p4,
		environment,
		revision: conventional.revisions[0],
		workspace
	});
	await advancePast(conventionalBaseline.submittedAtSeconds);
	const conventionalMove = await submitFixtureRevision({
		p4,
		environment,
		revision: conventional.revisions[1],
		workspace
	});

	const unrelatedPath = workspacePath(workspace, "Content/Fixture/Unrelated/L_Unrelated.umap");
	await mkdir(dirname(unrelatedPath), { recursive: true });
	await copyFile(
		resolve(fixtureRoot, "revisions", "conventional-baseline", conventional.mapPath),
		unrelatedPath
	);
	await run(p4, ["add", "-t", "binary", unrelatedPath], { cwd: workspace, env: environment });
	await run(p4, ["submit", "-d", "Map History fixture: unrelated map"], {
		cwd: workspace,
		env: environment
	});

	const worldPartitionBaseline = await submitFixtureRevision({
		p4,
		environment,
		revision: worldPartition.revisions[0],
		workspace
	});
	await advancePast(worldPartitionBaseline.submittedAtSeconds);
	const worldPartitionRevisions = [];
	for (const revision of worldPartition.revisions.slice(1)) {
		worldPartitionRevisions.push(
			await submitFixtureRevision({ p4, environment, revision, workspace })
		);
	}
	const lastInRange = worldPartitionRevisions.at(-1);
	assert(lastInRange !== undefined, "World Partition fixture needs an in-range revision.");
	await advancePast(lastInRange.submittedAtSeconds);
	const outOfRangePath = workspacePath(
		workspace,
		"Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC.uasset"
	);
	await run(p4, ["edit", outOfRangePath], { cwd: workspace, env: environment });
	await copyFile(
		resolve(
			fixtureRoot,
			"revisions",
			"move-east",
			"Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/C/N1/9RPECC7KRB3DWFR00UEDPC.uasset"
		),
		outOfRangePath
	);
	await run(p4, ["submit", "-d", "Map History fixture: out of range"], {
		cwd: workspace,
		env: environment
	});

	return {
		conventional: {
			baseline: conventionalBaseline,
			mapPath: conventional.mapPath,
			range: {
				since: new Date(
					(conventionalBaseline.submittedAtSeconds + 0.5) * 1_000
				).toISOString(),
				until: new Date((conventionalMove.submittedAtSeconds + 0.999) * 1_000).toISOString()
			},
			revisions: [conventionalMove]
		},
		worldPartition: {
			baseline: worldPartitionBaseline,
			mapPath: worldPartition.mapPath,
			range: {
				since: new Date(
					(worldPartitionBaseline.submittedAtSeconds + 0.5) * 1_000
				).toISOString(),
				until: new Date((lastInRange.submittedAtSeconds + 0.999) * 1_000).toISOString()
			},
			revisions: worldPartitionRevisions
		}
	};
}

async function stopServer({ child, p4, environment, cwd }) {
	try {
		await run(p4, ["admin", "stop"], { cwd, env: environment, timeoutMs: 5_000 });
	} catch {
		// The process fallback below is still scoped to this operation.
	}
	if (child.exitCode === null && child.signalCode === null) child.kill();
	await waitForProcessExit(child);
}

/**
 * Starts the generic Map History fixture and returns its isolated Perforce client.
 * Call `stop` once the caller has finished using the workspace.
 */
export async function startPerforceMapHistoryFixture() {
	report("RUN ", "starting the disposable localhost p4d conformance lane");
	const binaries = await resolveBinaries();
	const operationRoot = await mkdtemp(join(tmpdir(), "ue-shed-perforce-map-history-"));
	const serverRoot = join(operationRoot, "server");
	const workspace = join(operationRoot, "workspace");
	const tickets = join(operationRoot, "tickets.txt");
	const trust = join(operationRoot, "trust.txt");
	const enviro = join(operationRoot, "p4enviro.txt");
	const port = await getAvailablePort();
	const p4Port = `127.0.0.1:${port}`;
	const environment = p4Environment({
		P4CHARSET: "none",
		P4CLIENT: fixtureClient,
		P4CONFIG: configFileName,
		P4ENVIRO: enviro,
		P4HOST: fixtureClient,
		P4PORT: p4Port,
		P4TICKETS: tickets,
		P4TRUST: trust,
		P4USER: fixtureUser
	});
	let server;
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		if (server) {
			await stopServer({ child: server, p4: binaries.p4, environment, cwd: operationRoot });
		}
		try {
			await rm(operationRoot, {
				force: true,
				recursive: true,
				maxRetries: 3,
				retryDelay: 100
			});
		} catch (error) {
			report(
				"WARN",
				`could not remove the failed disposable operation root ${operationRoot}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
		report("RUN ", "removed the disposable p4d server, client, tickets, and workspace");
	};
	try {
		await Promise.all([mkdir(serverRoot), mkdir(workspace), writeFile(enviro, "")]);
		const configuration = [
			`P4PORT=${p4Port}`,
			`P4USER=${fixtureUser}`,
			`P4CLIENT=${fixtureClient}`,
			`P4TICKETS=${tickets}`,
			`P4TRUST=${trust}`,
			"P4CHARSET=none",
			""
		].join("\n");
		await writeFile(join(operationRoot, configFileName), configuration);
		const startServer = () =>
			spawn(
				binaries.p4d,
				["-r", serverRoot, "-p", p4Port, "-L", join(operationRoot, "p4d.log")],
				{
					cwd: operationRoot,
					env: p4Environment(),
					stdio: "ignore",
					windowsHide: true
				}
			);
		server = startServer();
		await waitForServer(binaries.p4, environment, operationRoot);
		server.kill();
		await waitForProcessExit(server);
		for (const setting of [
			"security=0",
			"dm.user.hideinvalid=0",
			"dm.user.noautocreate=1",
			"dm.user.setinitialpasswd=1"
		]) {
			await run(binaries.p4d, ["-r", serverRoot, `-cset ${setting}`], {
				cwd: operationRoot,
				env: p4Environment()
			});
		}
		server = startServer();
		await waitForServer(binaries.p4, environment, operationRoot);
		await run(binaries.p4, ["user", "-i"], {
			cwd: operationRoot,
			env: environment,
			input: [
				`User: ${fixtureUser}`,
				"Email: ue-shed-map-history@example.invalid",
				"FullName: UE Shed Perforce Map History Fixture",
				"Type: standard",
				"AuthMethod: perforce",
				""
			].join("\n")
		});
		const password = `A!${randomBytes(18).toString("base64url")}9z`;
		await run(binaries.p4, ["passwd"], {
			cwd: operationRoot,
			env: environment,
			input: `${password}\n${password}\n`
		});
		await run(binaries.p4, ["login"], {
			cwd: operationRoot,
			env: environment,
			input: `${password}\n`
		});
		for (const setting of [
			"dm.user.hideinvalid=1",
			"dm.user.noautocreate=2",
			"dm.user.setinitialpasswd=0",
			"run.users.authorize=1",
			"security=4"
		]) {
			await run(binaries.p4, ["configure", "set", setting], {
				cwd: operationRoot,
				env: environment
			});
		}
		await createDepot(binaries.p4, environment, operationRoot);
		await createClient(binaries.p4, environment, workspace);
		const seeded = await seedFixture({ p4: binaries.p4, environment, workspace });
		return {
			environment,
			operationRoot,
			p4: {
				client: fixtureClient,
				configFileName,
				enviro,
				executable: binaries.p4,
				port: p4Port,
				tickets,
				trust,
				user: fixtureUser
			},
			projectRoot: workspace,
			seeded,
			stop
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

async function main() {
	const fixture = await startPerforceMapHistoryFixture();
	try {
		const testConfigPath = join(fixture.operationRoot, "test-config.json");
		await writeFile(
			testConfigPath,
			JSON.stringify(
				{
					p4: fixture.p4,
					projectRoot: fixture.projectRoot,
					seeded: fixture.seeded,
					uassetExecutable: ensureUassetExecutable()
				},
				null,
				2
			)
		);
		const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
		const result = await run(
			process.execPath,
			[vitest, "run", "packages/map-history/src/perforce-map-history.integration.test.ts"],
			{
				cwd: repositoryRoot,
				env: {
					...fixture.environment,
					UE_SHED_PERFORCE_MAP_HISTORY_CONFIG: testConfigPath,
					UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable()
				},
				timeoutMs: 120_000
			}
		);
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	} finally {
		await fixture.stop();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		report("FAIL", error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
