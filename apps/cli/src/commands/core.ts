import { Command } from "effect/unstable/cli";
import { runDoctor, runVersion } from "../core-workflows.js";

export const versionCommand = Command.make("version", {}, runVersion).pipe(
	Command.withDescription("Print the UE Shed and protocol versions.")
);

export const doctorCommand = Command.make("doctor", {}, runDoctor).pipe(
	Command.withDescription("Report local service and capability health.")
);
