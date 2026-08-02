import { Effect } from "effect";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type AuditTexturesCommand = Extract<CliCommand, { readonly _tag: "AuditTextures" }>;

export const runAuditTextures = Effect.fn("Cli.workflow.audit_textures")(
	(command: AuditTexturesCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { TextureAudit, TextureAuditLive } = yield* Effect.promise(
					() => import("@ue-shed/asset-audits")
				);
				const report = yield* Effect.gen(function* () {
					const audit = yield* TextureAudit;
					return yield* audit.scan({
						projectRoot: command.projectRoot,
						ruleFile: command.ruleFile
					});
				}).pipe(
					Effect.provide(TextureAuditLive),
					Effect.provide(readerLayer(command.reader))
				);
				return yield* printJson(report);
			})
		)
);
