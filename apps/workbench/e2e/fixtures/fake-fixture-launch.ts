import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeFixtureLaunchHarness {
	readonly checkoutRoot: string;
	readonly endpoint: string;
	readonly launchMarkerPath: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly launchCount: () => Promise<number>;
	readonly markerExists: () => Promise<boolean>;
	readonly close: () => Promise<void>;
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = [];
		request.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		request.on("error", reject);
	});
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Temporary source-checkout + Remote Control stand-in for demand-launch E2E.
 * The fake launcher writes a marker and flips health; production services stay unchanged.
 */
export async function createFakeFixtureLaunchHarness(options?: {
	readonly launchDelayMs?: number;
	readonly projectName?: string;
}): Promise<FakeFixtureLaunchHarness> {
	const launchDelayMs = options?.launchDelayMs ?? 1_500;
	const projectName = options?.projectName ?? process.env.UE_SHED_PROJECT_NAME ?? "UEShedFixture";
	const root = await mkdtemp(join(tmpdir(), "ue-shed-fake-fixture-"));
	const checkoutRoot = join(root, "checkout");
	const scriptsDir = join(checkoutRoot, "scripts");
	const launchMarkerPath = join(root, "launch.marker");
	const healthyFlagPath = join(root, "healthy.flag");
	await mkdir(scriptsDir, { recursive: true });

	await writeFile(
		join(scriptsDir, "unreal-fixture.ts"),
		`import { appendFileSync, writeFileSync } from "node:fs";

const marker = process.env.UE_SHED_FAKE_LAUNCH_MARKER;
const healthy = process.env.UE_SHED_FAKE_HEALTHY_FLAG;
const delayMs = Number(process.env.UE_SHED_FAKE_LAUNCH_DELAY_MS ?? "0");
if (!marker || !healthy) {
	console.error("Fake fixture launcher is missing marker environment.");
	process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, delayMs));
appendFileSync(marker, \`\${Date.now()}\\n\`, "utf8");
writeFileSync(healthy, "1", "utf8");
process.exit(0);
`
	);

	let healthy = false;
	const server: Server = createServer((request, response) => {
		void (async () => {
			if (request.method === "PUT" && request.url === "/remote/object/call") {
				if (!healthy && (await pathExists(healthyFlagPath))) {
					healthy = true;
				}
				if (!healthy) {
					response.writeHead(503);
					response.end("not ready");
					return;
				}
				const body = await readBody(request);
				const payload = JSON.parse(body) as { functionName?: string };
				if (payload.functionName === "GetCapabilityManifest") {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							ResultJson: JSON.stringify({
								capabilities: [],
								producerKind: "unreal_editor",
								projectName,
								schemaVersion: 1
							})
						})
					);
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ ResultJson: "{}" }));
				return;
			}
			response.writeHead(404);
			response.end();
		})().catch(() => {
			response.writeHead(500);
			response.end("fake remote control failure");
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Fake Remote Control server did not bind a TCP port");
	}
	const endpoint = `http://127.0.0.1:${address.port}`;

	return {
		checkoutRoot,
		endpoint,
		launchMarkerPath,
		environment: {
			UE_SHED_FAKE_HEALTHY_FLAG: healthyFlagPath,
			UE_SHED_FAKE_LAUNCH_DELAY_MS: String(launchDelayMs),
			UE_SHED_FAKE_LAUNCH_MARKER: launchMarkerPath,
			UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
			UE_SHED_REPOSITORY_ROOT: checkoutRoot
		},
		launchCount: async () => {
			if (!(await pathExists(launchMarkerPath))) return 0;
			const text = await readFile(launchMarkerPath, "utf8");
			return text.split("\n").filter((line) => line.length > 0).length;
		},
		markerExists: () => pathExists(launchMarkerPath),
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			await rm(root, { force: true, recursive: true });
		}
	};
}
