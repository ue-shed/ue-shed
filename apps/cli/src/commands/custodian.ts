import { CustodianTargetId } from "@ue-shed/project-custodian";
import { Argument, Command, Flag } from "effect/cli";
import { lazyWorkflow } from "../lazy-workflows.js";

const runCustodianApply = lazyWorkflow(
	() => import("../workflows/custodian.js"),
	(module) => module.runCustodianApply
);
const runCustodianPlan = lazyWorkflow(
	() => import("../workflows/custodian.js"),
	(module) => module.runCustodianPlan
);
const runCustodianPrepare = lazyWorkflow(
	() => import("../workflows/custodian.js"),
	(module) => module.runCustodianPrepare
);
const runCustodianReport = lazyWorkflow(
	() => import("../workflows/custodian.js"),
	(module) => module.runCustodianReport
);

const report = Command.make("report", { root: Argument.String("root") }, ({ root }) =>
	runCustodianReport({ _tag: "CustodianReport", root })
).pipe(
	Command.withDescription(
		"Inventory regeneratable Unreal project and engine storage beneath an explicit root."
	)
);

const plan = Command.make(
	"plan",
	{
		root: Argument.String("root"),
		ignorePressure: Flag.Boolean("ignore-pressure").pipe(Flag.withDefault(false))
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
		root: Argument.String("root"),
		ignorePressure: Flag.Boolean("ignore-pressure").pipe(Flag.withDefault(false)),
		mode: Flag.Literals("mode", ["trash", "permanent"]).pipe(Flag.withDefault("trash")),
		outputDirectory: Flag.String("output"),
		targetIds: Flag.String("target").pipe(Flag.atLeast(1))
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
		proposalPath: Argument.String("proposal"),
		approvalPhrase: Flag.String("approve")
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
