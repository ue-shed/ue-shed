import { Argument, Command, Flag } from "effect/unstable/cli";
import { runCustodianPlan, runCustodianReport } from "../workflows/custodian.js";

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

export const custodianCommand = Command.make("custodian").pipe(
	Command.withDescription("Explain reclaimable Unreal workspace storage without opening Unreal."),
	Command.withSubcommands([report, plan])
);
