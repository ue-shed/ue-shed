import { spawnSync } from "node:child_process";
import { createHash, type BinaryLike } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PACKAGES, PUBLIC_VERSION } from "./pack-public-packages.ts";

const npmRegistry = "https://registry.npmjs.org";
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const tagPattern = /^[a-z0-9][a-z0-9._-]*$/u;

export interface PublicationEntry {
	readonly name: string;
	readonly version: string;
	readonly license?: string;
	readonly filename: string;
	readonly sha256: string;
	readonly bytes: number;
}

interface PublicationManifest {
	readonly schemaVersion: number;
	readonly version: string;
	readonly packages: PublicationEntry[];
}

export interface PublishRequest {
	readonly tarball: string;
	readonly tag: string;
	readonly provenance: boolean;
}

type MaybePromise<T> = T | Promise<T>;

function executable(name: string) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function runNpm(args: readonly string[], { inherit = false }: { inherit?: boolean } = {}) {
	const command = executable("npm");
	const isCommandShim = process.platform === "win32";
	const result = spawnSync(
		isCommandShim ? (process.env.ComSpec ?? "cmd.exe") : command,
		isCommandShim ? ["/d", "/s", "/c", command, ...args] : args,
		{
			encoding: "utf8",
			shell: false,
			stdio: inherit ? "inherit" : "pipe"
		}
	);
	if (result.error) throw result.error;
	return result;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

export function sha512Integrity(bytes: BinaryLike) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function parseRegistryIntegrity({
	packageSpec,
	status,
	stdout = "",
	stderr = ""
}: {
	readonly packageSpec: string;
	readonly status: number | null;
	readonly stdout?: string;
	readonly stderr?: string;
}) {
	if (status === 0) {
		const value = parseJson(stdout.trim());
		if (typeof value !== "string" || !integrityPattern.test(value)) {
			throw new Error(
				`Registry returned invalid dist.integrity for ${packageSpec}: ${stdout.trim() || "empty output"}.`
			);
		}
		return value;
	}
	const errorPayload = parseJson(stdout.trim()) ?? parseJson(stderr.trim());
	const combined = `${stdout}\n${stderr}`;
	const errorCode =
		typeof errorPayload === "object" &&
		errorPayload !== null &&
		"error" in errorPayload &&
		typeof errorPayload.error === "object" &&
		errorPayload.error !== null &&
		"code" in errorPayload.error
			? errorPayload.error.code
			: undefined;
	if (errorCode === "E404" || /(?:^|\s)E404(?:\s|$)/u.test(combined)) {
		return null;
	}
	throw new Error(
		`Registry query failed for ${packageSpec} with status ${status ?? "unknown"}:\n${combined.trim()}`
	);
}

export function publicationDecision({
	packageSpec,
	localIntegrity,
	registryIntegrity
}: {
	readonly packageSpec: string;
	readonly localIntegrity: string;
	readonly registryIntegrity: string | null;
}) {
	if (!integrityPattern.test(localIntegrity)) {
		throw new Error(`Local integrity for ${packageSpec} is not SHA-512 SRI.`);
	}
	if (registryIntegrity === null) return { action: "publish", integrity: localIntegrity };
	if (!integrityPattern.test(registryIntegrity)) {
		throw new Error(`Registry integrity for ${packageSpec} is not SHA-512 SRI.`);
	}
	if (registryIntegrity === localIntegrity) {
		return { action: "skip", integrity: localIntegrity };
	}
	throw new Error(
		`Registry integrity mismatch for ${packageSpec}.\n` +
			`Local:    ${localIntegrity}\n` +
			`Registry: ${registryIntegrity}`
	);
}

export function validatePublicationManifest({
	manifest,
	expectedVersion
}: {
	readonly manifest: PublicationManifest;
	readonly expectedVersion: string;
}) {
	const failures: string[] = [];
	if (manifest?.schemaVersion !== 1) failures.push("schemaVersion must be 1");
	if (manifest?.version !== expectedVersion) {
		failures.push(`manifest version must be ${expectedVersion}`);
	}
	const expectedNames = PUBLIC_PACKAGES.map(({ name }) => name);
	const actualNames = manifest.packages.map(({ name }) => name);
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		failures.push(`package order must be ${expectedNames.join(", ")}`);
	}
	for (const entry of manifest.packages) {
		if (entry.version !== expectedVersion) {
			failures.push(`${entry.name} version must be ${expectedVersion}`);
		}
		if (entry.license !== "MIT") failures.push(`${entry.name} license must be MIT`);
		if (typeof entry.filename !== "string" || basename(entry.filename) !== entry.filename) {
			failures.push(`${entry.name} filename must be a basename`);
		}
		if (typeof entry.sha256 !== "string" || !digestPattern.test(entry.sha256)) {
			failures.push(`${entry.name} sha256 must be an exact lowercase digest`);
		}
		if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
			failures.push(`${entry.name} bytes must be a positive integer`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Invalid publication manifest:\n- ${failures.join("\n- ")}`);
	}
	return manifest.packages;
}

function queryRegistryIntegrity(packageSpec: string) {
	const result = runNpm([
		"view",
		packageSpec,
		"dist.integrity",
		"--json",
		`--registry=${npmRegistry}`
	]);
	return parseRegistryIntegrity({
		packageSpec,
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr
	});
}

function publishTarball({ tarball, tag, provenance }: PublishRequest) {
	const args = [
		"publish",
		tarball,
		"--access",
		"public",
		"--tag",
		tag,
		`--registry=${npmRegistry}`
	];
	if (provenance) args.push("--provenance");
	const result = runNpm(args, { inherit: true });
	if (result.status !== 0) {
		throw new Error(
			`npm publish failed for ${tarball} with status ${result.status ?? "unknown"}.`
		);
	}
}

export async function reconcilePackage({
	entry,
	directory,
	tag,
	provenance,
	queryIntegrity = queryRegistryIntegrity,
	publish = publishTarball
}: {
	readonly entry: PublicationEntry;
	readonly directory: string;
	readonly tag: string;
	readonly provenance: boolean;
	readonly queryIntegrity?: (packageSpec: string) => MaybePromise<string | null>;
	readonly publish?: (request: PublishRequest) => MaybePromise<unknown>;
}) {
	const tarball = join(resolve(directory), entry.filename);
	const bytes = await readFile(tarball);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== entry.sha256 || bytes.length !== entry.bytes) {
		throw new Error(`Candidate checksum or byte count changed for ${entry.name}.`);
	}
	const packageSpec = `${entry.name}@${entry.version}`;
	const localIntegrity = sha512Integrity(bytes);
	const registryIntegrity = await queryIntegrity(packageSpec);
	const decision = publicationDecision({ packageSpec, localIntegrity, registryIntegrity });
	if (decision.action === "skip") {
		console.log(`${packageSpec} already exists with matching integrity; skipping.`);
		return decision;
	}
	console.log(`${packageSpec} is absent; publishing ${entry.filename}.`);
	await publish({ tarball, tag, provenance });
	return decision;
}

export async function publishPublicPackages({
	manifestPath,
	expectedVersion,
	tag,
	only,
	provenance = false
}: {
	readonly manifestPath: string;
	readonly expectedVersion: string;
	readonly tag: string;
	readonly only?: string | undefined;
	readonly provenance?: boolean;
}) {
	if (expectedVersion !== PUBLIC_VERSION) {
		throw new Error(
			`Publication version must be ${PUBLIC_VERSION}, received ${expectedVersion}.`
		);
	}
	if (!tagPattern.test(tag)) throw new Error(`Invalid npm dist-tag ${tag}.`);
	const resolvedManifestPath = resolve(manifestPath);
	const manifest = JSON.parse(
		await readFile(resolvedManifestPath, "utf8")
	) as PublicationManifest;
	const entries = validatePublicationManifest({ manifest, expectedVersion });
	const selected = only === undefined ? entries : entries.filter(({ name }) => name === only);
	if (selected.length === 0) throw new Error(`Publication manifest does not contain ${only}.`);
	for (const entry of selected) {
		await reconcilePackage({
			entry,
			directory: dirname(resolvedManifestPath),
			tag,
			provenance
		});
	}
}

function parseArguments(args: readonly string[]) {
	const values = new Map<string, string | boolean>();
	for (let index = 0; index < args.length; index += 1) {
		const key = args[index];
		if (key === "--provenance") {
			values.set("provenance", true);
			continue;
		}
		if (!key?.startsWith("--") || args[index + 1] === undefined) {
			throw new Error(
				"Usage: node scripts/publish-public-packages.ts --manifest <path> " +
					"--version <exact-version> --tag <dist-tag> [--only <package>] [--provenance]"
			);
		}
		values.set(key.slice(2), args[index + 1]);
		index += 1;
	}
	for (const required of ["manifest", "version", "tag"]) {
		if (!values.has(required)) throw new Error(`Missing required --${required} argument.`);
	}
	return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parseArguments(process.argv.slice(2));
	await publishPublicPackages({
		manifestPath: args.get("manifest") as string,
		expectedVersion: args.get("version") as string,
		tag: args.get("tag") as string,
		only: args.get("only") as string | undefined,
		provenance: args.has("provenance")
	});
}
