import { optionalFlag, optionalValue } from "./options.js";
import { Command } from "effect/unstable/cli";
import { runDoctor, runVersion, runProducerDoctor } from "../core-workflows.js";

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
