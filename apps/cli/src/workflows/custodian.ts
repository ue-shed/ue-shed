import { Custodian, CustodianNodeLive } from "@ue-shed/project-custodian";
import { Effect } from "effect";
import { observeCliOperation } from "../cli-operation.js";
import { printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;

export const runCustodianReport = Effect.fn("Cli.workflow.custodian_report")(
	(command: Command<"CustodianReport">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const custodian = yield* Custodian;
				const report = yield* custodian.scan({ root: command.root });
				return yield* printJson(report);
			}).pipe(Effect.provide(CustodianNodeLive))
		)
);

export const runCustodianPlan = Effect.fn("Cli.workflow.custodian_plan")(
	(command: Command<"CustodianPlan">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const custodian = yield* Custodian;
				const report = yield* custodian.scan({
					root: command.root,
					ignorePressure: command.ignorePressure
				});
				return yield* printJson({
					schemaVersion: report.schemaVersion,
					root: report.root,
					measuredAt: report.measuredAt,
					plan: report.plan,
					destructiveOperationsAvailable: report.destructiveOperationsAvailable
				});
			}).pipe(Effect.provide(CustodianNodeLive))
		)
);
