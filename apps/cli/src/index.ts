import { CURRENT_PROTOCOL_VERSION } from "@ue-shed/protocol";

const help = `UE Shed — External tools for Unreal Engine development.

Usage:
  ue-shed <command>

Commands:
  doctor        Diagnose discovery, connection, and capability support (planned)
  capabilities List capabilities exposed by a connected Unreal session (planned)
  version       Print the scaffold and protocol versions
  help          Show this help

The initial scaffold exposes the command surface without pretending the Unreal spine exists yet.`;

function printVersion(): void {
	const protocol = CURRENT_PROTOCOL_VERSION;
	console.log(`ue-shed 0.0.0 (protocol ${protocol.major}.${protocol.minor})`);
}

function main(args: readonly string[]): void {
	const [command] = args;

	switch (command) {
		case "version":
		case "--version":
		case "-v":
			printVersion();
			return;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(help);
			return;
		case "doctor":
		case "capabilities":
			console.error(`${command} is reserved for the first Unreal connection slice.`);
			process.exitCode = 2;
			return;
		default:
			console.error(`Unknown command: ${command}\n\n${help}`);
			process.exitCode = 2;
	}
}

main(process.argv.slice(2));
