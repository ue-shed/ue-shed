import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { Effect, Predicate, Schema } from "effect";
import { ScenarioDocument } from "./schema.js";

/** Largest scenario document file, in bytes, that is read or written: 4 MiB. */
export const MAX_SCENARIO_DOCUMENT_BYTES = 4 * 1024 * 1024;
const documentJson = Schema.fromJsonString(ScenarioDocument);

export class ScenarioDocumentFileError extends Schema.TaggedError<ScenarioDocumentFileError>()(
	"ScenarioDocumentFileError",
	{ path: Schema.String, ...ErrorGuidanceFields, ...ErrorCauseFields }
) {}
const isScenarioDocumentFileError = Schema.is(ScenarioDocumentFileError);

class DocumentTooLarge extends Error {
	constructor() {
		super("Document exceeds 4 MiB.");
	}
}

const errnoCode = (cause: unknown): string | undefined =>
	Predicate.isObject(cause) && "code" in cause && Predicate.isString(cause.code)
		? cause.code
		: undefined;

const failureMessage = (operation: "read" | "save", path: string, cause: unknown): string => {
	if (cause instanceof DocumentTooLarge) return `The scenario document ${path} exceeds 4 MiB.`;
	if (Schema.isSchemaError(cause)) {
		return operation === "read"
			? `The scenario document ${path} is not a valid version 1 scenario.`
			: `The scenario document was not saved to ${path} because it is not a valid version 1 scenario.`;
	}
	const code = errnoCode(cause);
	if (code === "ENOENT" && operation === "read") {
		return `The scenario document ${path} does not exist.`;
	}
	if (code === "EACCES" || code === "EPERM") {
		return `Permission was denied to ${operation} the scenario document ${path}.`;
	}
	return `Could not ${operation} the scenario document ${path}.`;
};

/**
 * Reads are always repeatable. Saves stage a private temporary file and rename it over the
 * destination, so repeating one is idempotent too. Invalid or oversized documents and denied
 * permissions need a changed input; other filesystem failures may clear on their own.
 */
const documentFileGuidance = (
	operation: "read" | "save",
	cause: unknown
): Pick<ScenarioDocumentFileError, "nextStep" | "retrySafe"> => {
	const code = errnoCode(cause);
	const needsInput =
		cause instanceof DocumentTooLarge ||
		Schema.isSchemaError(cause) ||
		code === "EACCES" ||
		code === "EPERM" ||
		(code === "ENOENT" && operation === "read");
	return { retrySafe: true, nextStep: needsInput ? "fix_input" : "retry" };
};

const failure = (operation: "read" | "save", path: string, cause: unknown) =>
	isScenarioDocumentFileError(cause)
		? cause
		: new ScenarioDocumentFileError({
				path,
				message: failureMessage(operation, path, cause),
				recovery:
					"Use a valid version 1 scenario JSON file under 4 MiB and check file permissions.",
				...documentFileGuidance(operation, cause),
				cause
			});

export const readScenarioDocumentFile = Effect.fn("ScenarioDocumentFile.read")((path: string) =>
	Effect.tryPromise({
		try: async () => {
			if ((await stat(path)).size > MAX_SCENARIO_DOCUMENT_BYTES) throw new DocumentTooLarge();
			const bytes = await readFile(path);
			if (bytes.length > MAX_SCENARIO_DOCUMENT_BYTES) throw new DocumentTooLarge();
			return bytes.toString("utf8");
		},
		catch: (cause) => failure("read", path, cause)
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(documentJson)),
		Effect.mapError((cause) => failure("read", path, cause))
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
						if (bytes.length > MAX_SCENARIO_DOCUMENT_BYTES)
							throw new DocumentTooLarge();
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
					catch: (cause) => failure("save", path, cause)
				})
			),
			Effect.mapError((cause) => failure("save", path, cause))
		)
);
