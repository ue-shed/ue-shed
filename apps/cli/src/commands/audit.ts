import { Argument, Command, Flag } from "effect/cli";
import { optionalFlag, readerFields } from "./options.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runAuditTextures = lazyWorkflow(
	() => import("../workflows/audit.js"),
	(module) => module.runAuditTextures
);

const auditTexturesCommand = Command.make(
	"textures",
	{
		projectRoot: Argument.String("project-root"),
		ruleFile: Flag.String("rules"),
		reader: optionalFlag("reader")
	},
	({ projectRoot, ruleFile, reader }) =>
		runAuditTextures({
			_tag: "AuditTextures",
			projectRoot,
			ruleFile,
			...readerFields(reader)
		})
).pipe(Command.withDescription("Audit saved Texture2D assets against rule definitions."));

export const auditCommand = Command.make("audit").pipe(
	Command.withDescription("Run saved-asset audits."),
	Command.withSubcommands([auditTexturesCommand])
);
