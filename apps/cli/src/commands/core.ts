import { optionalFlag, optionalValue } from "./options.js";
import { Command } from "effect/cli";
import { lazyWorkflow } from "../lazy-workflows.js";

const runDoctor = lazyWorkflow(
	() => import("../core-workflows.js"),
	(module) => module.runDoctor
);
const runVersion = lazyWorkflow(
	() => import("../core-workflows.js"),
	(module) => module.runVersion
);
const runProducerDoctor = lazyWorkflow(
	() => import("../core-workflows.js"),
	(module) => module.runProducerDoctor
);

export const versionCommand = Command.make("version", {}, runVersion).pipe(
	Command.withDescription("Print the UE Shed and protocol versions.")
);

export const doctorCommand = Command.make(
	"doctor",
	{ endpoint: optionalFlag("endpoint") },
	({ endpoint }) => {
		const target = optionalValue(endpoint);
		return target === undefined ? runDoctor() : runProducerDoctor(target);
	}
).pipe(Command.withDescription("Report local service and capability health."));
