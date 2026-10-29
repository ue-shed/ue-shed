import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MapHistoryError } from "@ue-shed/map-history";
import { cliFailureCode, cliFailureExit, readCliFailure, withCliTables } from "./cli-exit.js";
import { CliCommandError } from "./cli-runtime.js";
import { CliSignalError } from "./signal.js";

const docs = fileURLToPath(new URL("../../../docs/products/game-text.md", import.meta.url));

const wrapped = (cause: unknown) =>
	new CliCommandError({
		cause,
		recovery:
			"Inspect the command context and original cause before deciding whether to retry.",
		retrySafe: false,
		nextStep: "escalate",
		code: "cli_command_failed",
		message: "wrapped"
	});

const exitOf = (error: { readonly cause?: unknown }) => cliFailureExit(readCliFailure(error));
const codeOf = (error: { readonly cause?: unknown }) => cliFailureCode(readCliFailure(error));

const perforce = (kind: MapHistoryError["kind"], nextStep: MapHistoryError["nextStep"]) =>
	new MapHistoryError({
		kind,
		message: "Perforce said no.",
		recovery: "Do something.",
		retrySafe: nextStep === "retry",
		nextStep
	});

describe("exit codes", () => {
	it("keep the docs' exit and error tables as the CLI generates them", () => {
		const document = readFileSync(docs, "utf8");
		expect(withCliTables(document)).toBe(document);
	});

	it("exit by the typed cause's next step, through the CLI's generic error", () => {
		expect(exitOf(wrapped(perforce("perforce_command", "retry")))).toBe(3);
		expect(exitOf(wrapped(perforce("invalid_target", "fix_input")))).toBe(2);
		expect(exitOf(perforce("perforce_command", "escalate"))).toBe(2);
		expect(exitOf(wrapped(new Error("untyped")))).toBe(2);
		expect(exitOf(new Error("untyped"))).toBe(4);
		expect(
			exitOf(
				wrapped(
					new CliSignalError({
						message: "Interrupted.",
						recovery: "Run it again.",
						retrySafe: false,
						nextStep: "reconcile",
						code: "cli_signal_failed",
						signal: "SIGINT"
					})
				)
			)
		).toBe(130);
	});

	it("name a failure by its code or a Map History error's kind, never the generic one", () => {
		expect(codeOf(wrapped(perforce("ambiguous_depot_mapping", "fix_input")))).toBe(
			"ambiguous_depot_mapping"
		);
		expect(codeOf(wrapped(new Error("untyped")))).toBeUndefined();
	});
});
