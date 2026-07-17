import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import {
	AuthoringClient,
	decodeAuthoringTransportRequest,
	dispatchAuthoringTransportRequest
} from "@ue-shed/authoring-sdk";
import {
	AuthoringFilePickerCancelled,
	ShedHostLive,
	shedHostConfigurationLayer
} from "@ue-shed/host";
import { Config, Effect, Layer, ManagedRuntime, Option } from "effect";

const maxRequestBytes = 1024 * 1024;
const staticRoot = resolve(import.meta.dirname, "../../app/dist");

const configurationLive = Layer.unwrap(
	Effect.gen(function* () {
		const projectRoot = yield* Config.string("UE_SHED_PROJECT_ROOT");
		const remoteControlEndpoint = yield* Config.option(
			Config.string("UE_SHED_REMOTE_CONTROL_ENDPOINT")
		);
		return shedHostConfigurationLayer({
			authoringAsset: { status: "not_configured" },
			project: {
				catalogCachePath: resolve(
					import.meta.dirname,
					"../../.ue-shed/catalog/index-v1.json"
				),
				projectRoot,
				sessionStorageRoot: resolve(
					import.meta.dirname,
					"../../.ue-shed/authoring/sessions"
				),
				status: "configured"
			},
			remoteControlEndpoint: Option.getOrElse(
				remoteControlEndpoint,
				() => "http://127.0.0.1:30001"
			)
		});
	})
);

const runtime = ManagedRuntime.make(
	ShedHostLive.pipe(Layer.provide(configurationLive), Layer.provide(AuthoringFilePickerCancelled))
);

const contentTypes: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml"
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8"
	});
	response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxRequestBytes) throw new Error("Authoring request exceeds 1 MiB");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function handleAuthoring(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method !== "POST") {
		writeJson(response, 405, { error: "POST required" });
		return;
	}
	try {
		const input = await readJson(request);
		const decoded = await runtime.runPromise(decodeAuthoringTransportRequest(input));
		const client = await runtime.runPromise(AuthoringClient);
		const value = await runtime.runPromise(dispatchAuthoringTransportRequest(client, decoded));
		writeJson(response, 200, { status: "success", value });
	} catch (cause) {
		writeJson(response, 400, {
			error: {
				message: cause instanceof Error ? cause.message : String(cause),
				recovery:
					"Inspect the host terminal, correct the request or project configuration, and retry."
			},
			status: "transport_error"
		});
	}
}

async function handleStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
	const path = resolve(staticRoot, `.${requestedPath}`);
	const relativePath = relative(staticRoot, path);
	if (relativePath.startsWith("..") || resolve(path) !== path) {
		response.writeHead(404).end();
		return;
	}
	try {
		if (!(await stat(path)).isFile()) throw new Error("not a file");
		const body = await readFile(path);
		response.writeHead(200, {
			"content-type": contentTypes[extname(path)] ?? "application/octet-stream"
		});
		response.end(body);
	} catch {
		response.writeHead(404).end();
	}
}

const serverConfiguration = await Effect.runPromise(
	Effect.all({
		host: Config.string("UE_SHED_HOST_ADDRESS").pipe(Config.withDefault("127.0.0.1")),
		port: Config.number("UE_SHED_HOST_PORT").pipe(Config.withDefault(4174))
	})
);

const server = createServer((request, response) => {
	const operation = request.url?.startsWith("/api/authoring")
		? handleAuthoring(request, response)
		: handleStatic(request, response);
	void operation.catch((cause) => {
		writeJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
	});
});

server.listen(serverConfiguration.port, serverConfiguration.host, () => {
	process.stdout.write(
		`UE Shed adopted host listening at http://${serverConfiguration.host}:${serverConfiguration.port}\n`
	);
});

const shutdown = (): void => {
	server.close(() => {
		void runtime.dispose().finally(() => process.exit(0));
	});
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
