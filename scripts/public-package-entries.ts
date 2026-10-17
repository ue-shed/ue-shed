import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Schema, SchemaGetter } from "effect";

/** The parts of a `package.json` this measurement reads. */
const PackageJson = Schema.Struct({
	name: Schema.String,
	exports: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([
				Schema.String.pipe(
					Schema.decodeTo(Schema.Struct({ import: Schema.String }), {
						decode: SchemaGetter.transform((path: string) => ({ import: path })),
						encode: SchemaGetter.transform(({ import: path }) => path)
					})
				),
				Schema.Struct({
					import: Schema.optionalKey(Schema.String),
					default: Schema.optionalKey(Schema.String)
				})
			])
		)
	)
});

/** Each entry point's subpath and source file, from the package's `exports` map. */
export function publicPackageEntries(directory: string) {
	const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageJson))(
		readFileSync(join(directory, "package.json"), "utf8")
	);
	const entries = new Map<string, string>();
	for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
		const file = target.import ?? ("default" in target ? target.default : undefined);
		if (!file || !/\.(?:js|ts)$/u.test(file)) continue;
		// Published packages point at `dist/*.js`; private ones point straight at `src/*.ts`.
		const source = join(
			directory,
			file.replace(/^\.\/dist\//u, "src/").replace(/\.js$/u, ".ts")
		);
		try {
			if (statSync(source).isFile()) entries.set(subpath, source);
		} catch {
			// A non-TypeScript export (JSON schema, assets) has no names to measure.
		}
	}
	return { name: manifest.name, entries };
}
