import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, openSync, closeSync, readSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const defaultSource = resolve(repositoryRoot, "target", "release", "uasset.exe");
const defaultDestination = resolve(packageRoot, "bin", "uasset.exe");

function readPeMagic(path) {
	const descriptor = openSync(path, "r");
	try {
		const bytes = Buffer.alloc(2);
		if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) return "";
		return bytes.toString("ascii");
	} finally {
		closeSync(descriptor);
	}
}

export function assemble(options = {}) {
	const source = resolve(options.source ?? defaultSource);
	const destination = resolve(options.destination ?? defaultDestination);
	if (readPeMagic(source) !== "MZ") {
		throw new Error(`Expected a Windows PE executable at ${source}`);
	}
	if (options.verifyVersion !== false) {
		const version = execFileSync(source, ["--version"], {
			encoding: "utf8",
			windowsHide: true
		}).trim();
		if (version !== "uasset 0.1.0-rc.1") {
			throw new Error(`Expected uasset 0.1.0-rc.1, received ${JSON.stringify(version)}`);
		}
	}
	mkdirSync(dirname(destination), { recursive: true });
	rmSync(destination, { force: true });
	copyFileSync(source, destination);
	return destination;
}

function valueAfter(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const destination = assemble({
		source: valueAfter("--source"),
		destination: valueAfter("--destination")
	});
	process.stdout.write(`${destination}\n`);
}
