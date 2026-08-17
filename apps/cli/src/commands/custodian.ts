import { CustodianTargetId } from "@ue-shed/project-custodian";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	runCustodianApply,
	runCustodianPlan,
	runCustodianPrepare,
	runCustodianReport
} from "../workflows/custodian.js";

const report = Command.make("report", { root: Argument.string("root") }, ({ root }) =>
	runCustodianReport({ _tag: "CustodianReport", root })
).pipe(
	Command.withDescription(
		"Inventory regeneratable Unreal project and engine storage beneath an explicit root."
	)
);

const plan = Command.make(
	"plan",
	{
		root: Argument.string("root"),
		ignorePressure: Flag.boolean("ignore-pressure")
	},
	({ root, ignorePressure }) => runCustodianPlan({ _tag: "CustodianPlan", root, ignorePressure })
).pipe(
	Command.withDescription(
		"Build a largest-first dry-run plan. This command never deletes or moves files."
	)
);

const prepare = Command.make(
	"prepare",
	{
		root: Argument.string("root"),
		ignorePressure: Flag.boolean("ignore-pressure"),
		mode: Flag.choice("mode", ["trash", "permanent"]).pipe(Flag.withDefault("trash")),
		outputDirectory: Flag.string("output"),
		targetIds: Flag.string("target").pipe(Flag.atLeast(1))
	},
	({ root, ignorePressure, mode, outputDirectory, targetIds }) =>
		runCustodianPrepare({
			_tag: "CustodianPrepare",
			root,
			ignorePressure,
			mode,
			outputDirectory,
			targetIds: targetIds.map((targetId) => CustodianTargetId.make(targetId))
		})
).pipe(
	Command.withDescription(
		"Persist a reviewable cleanup proposal for explicitly selected target IDs."
	)
);

const apply = Command.make(
	"apply",
	{
		proposalPath: Argument.string("proposal"),
		approvalPhrase: Flag.string("approve")
	},
	({ proposalPath, approvalPhrase }) =>
		runCustodianApply({ _tag: "CustodianApply", proposalPath, approvalPhrase })
).pipe(
	Command.withDescription(
		"Revalidate and execute an approved proposal, with Trash/Recycle Bin as the default mode."
	)
);

export const custodianCommand = Command.make("custodian").pipe(
	Command.withDescription("Inspect and safely reclaim regeneratable Unreal workspace storage."),
	Command.withSubcommands([report, plan, prepare, apply])
);
