import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Schema } from "effect";

export const corpusScratchMarker = ".ue-shed-corpus-scratch.json";
const Marker = Schema.Struct({
	format: Schema.Literal("ue-shed-corpus-scratch"),
	version: Schema.Literal(1),
	project: Schema.String,
	descriptor: Schema.String
});

/** Refuse real projects before building or launching Unreal. Existing empty directories are safe. */
export function assertCorpusScratch(project: string) {
	const path = resolve(project),
		folder = dirname(path),
		marker = join(folder, corpusScratchMarker);
	for (let ancestor = folder; ; ancestor = dirname(ancestor)) {
		if (existsSync(join(ancestor, ".git")))
			throw new Error("Corpus scratch must be outside every repository.");
		if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
			throw new Error("Corpus scratch cannot use a linked directory.");
		if (dirname(ancestor) === ancestor) break;
	}
	if (!existsSync(marker)) {
		if (existsSync(folder) && readdirSync(folder).length)
			throw new Error(
				"Refusing a project the corpus generator did not create (no scratch marker)."
			);
		return;
	}
	const owned = Schema.decodeUnknownSync(Schema.fromJsonString(Marker))(
		readFileSync(marker, "utf8")
	);
	if (
		owned.project !== basename(path) ||
		!existsSync(path) ||
		readFileSync(path, "utf8") !== owned.descriptor
	)
		throw new Error("Refusing an altered or foreign scratch project descriptor.");
}

export function createCorpusScratch(project: string, engine: string) {
	assertCorpusScratch(project);
	const folder = dirname(resolve(project)),
		marker = join(folder, corpusScratchMarker);
	if (existsSync(marker)) return;
	const descriptor = JSON.stringify({
		FileVersion: 3,
		EngineAssociation: engine,
		Description: "UE Shed owned Game Text scratch"
	});
	mkdirSync(folder, { recursive: true });
	writeFileSync(project, descriptor, { flag: "wx" });
	writeFileSync(
		marker,
		JSON.stringify({
			format: "ue-shed-corpus-scratch",
			version: 1,
			project: basename(project),
			descriptor
		}),
		{ flag: "wx" }
	);
}
