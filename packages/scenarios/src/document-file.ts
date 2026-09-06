import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { ScenarioDocument } from "./schema.js";

const maximumBytes = 4 * 1024 * 1024;
const documentJson = Schema.fromJsonString(ScenarioDocument);

export class ScenarioDocumentFileError extends Schema.TaggedErrorClass<ScenarioDocumentFileError>()(
	"ScenarioDocumentFileError",
	{ message: Schema.String, path: Schema.String, recovery: Schema.String }
) {}

const failure = (path: string, cause: unknown) =>
	new ScenarioDocumentFileError({
		path,
		message: `Could not read or save the scenario document: ${String(cause)}`,
		recovery: "Use a valid version 1 scenario JSON file under 4 MiB and check file permissions."
	});

export const readScenarioDocumentFile = Effect.fn("ScenarioDocumentFile.read")((path: string) =>
	Effect.tryPromise({
		try: async () => {
			if ((await stat(path)).size > maximumBytes) throw new Error("Document exceeds 4 MiB.");
			const bytes = await readFile(path);
			if (bytes.length > maximumBytes) throw new Error("Document exceeds 4 MiB.");
			return bytes.toString("utf8");
		},
		catch: (cause) => failure(path, cause)
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(documentJson)),
		Effect.mapError((cause) => failure(path, cause))
	)
);

/** Write a validated document beside its destination, then atomically replace the file. */
export const writeScenarioDocumentFile = Effect.fn("ScenarioDocumentFile.write")(
	(path: string, document: ScenarioDocument) =>
		Schema.decodeUnknownEffect(ScenarioDocument)(document).pipe(
			Effect.flatMap((decoded) =>
				Effect.tryPromise({
					try: async () => {
						const bytes = Buffer.from(`${JSON.stringify(decoded, null, "\t")}\n`);
						if (bytes.length > maximumBytes) throw new Error("Document exceeds 4 MiB.");
						const destination = resolve(path);
						await mkdir(dirname(destination), { recursive: true });
						const temporary = await mkdtemp(
							join(dirname(destination), ".ue-shed-scenario-")
						);
						try {
							const staging = join(temporary, "document.json");
							await writeFile(staging, bytes, { flag: "wx" });
							await rename(staging, destination);
						} finally {
							await rm(temporary, { recursive: true, force: true });
						}
						return decoded;
					},
					catch: (cause) => failure(path, cause)
				})
			),
			Effect.mapError((cause) => failure(path, cause))
		)
);
