import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function ensureUassetExecutable(environment: NodeJS.ProcessEnv = process.env) {
	if (environment.UE_SHED_UASSET_EXECUTABLE) {
		return environment.UE_SHED_UASSET_EXECUTABLE;
	}

	const build = (command: string, env: NodeJS.ProcessEnv) =>
		spawnSync(command, ["build", "--locked", "-p", "uasset-io"], {
			cwd: repositoryRoot,
			env,
			stdio: "inherit",
			windowsHide: true
		});
	let result = build("cargo", environment);
	if (result.error && "code" in result.error && result.error.code === "ENOENT") {
		// Terminals opened before Rust was installed can retain a PATH without Cargo.
		const cargoHome = environment.CARGO_HOME
			? resolve(repositoryRoot, environment.CARGO_HOME)
			: join(homedir(), ".cargo");
		const bin = join(cargoHome, "bin");
		const cargo = join(bin, process.platform === "win32" ? "cargo.exe" : "cargo");
		if (existsSync(cargo)) {
			const pathKey =
				process.platform === "win32"
					? (Object.keys(environment).find((key) => key.toLowerCase() === "path") ??
						"PATH")
					: "PATH";
			result = build(cargo, {
				...environment,
				[pathKey]: `${bin}${delimiter}${environment[pathKey] ?? ""}`
			});
		}
	}
	if (result.error) {
		throw new Error(
			"Could not start Cargo to build the in-repo uasset IO executable. Install Rust 1.89 " +
				"or newer and restart your terminal, set CARGO_HOME to your Rust installation, or set " +
				"UE_SHED_UASSET_EXECUTABLE to a compatible executable.",
			{ cause: result.error }
		);
	}
	if (result.status !== 0) {
		throw new Error(
			`Building the in-repo uasset IO executable failed with exit code ${result.status}.`
		);
	}

	const cargoTargetDirectory = environment.CARGO_TARGET_DIR
		? resolve(repositoryRoot, environment.CARGO_TARGET_DIR)
		: join(repositoryRoot, "target");
	const executable = join(
		cargoTargetDirectory,
		"debug",
		process.platform === "win32" ? "uasset.exe" : "uasset"
	);
	if (!existsSync(executable)) {
		throw new Error(
			`Cargo completed without producing the expected executable at ${executable}.`
		);
	}
	return executable;
}

export { repositoryRoot };
