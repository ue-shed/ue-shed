import { Result, type Schema } from "effect";
import { expect, it } from "vitest";
import { makeEvidenceProjection } from "./evidence-projection.js";
import { parseArchive, parseManifest } from "./json-formats.js";
import { parsePO, projectPOEvidence } from "./po.js";

function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

it("keeps culture translations, pending PO edits and differing source metadata intact", () => {
	const projection = makeEvidenceProjection();
	const bytes = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value));
	const manifest = projection.manifest(
		success(
			parseManifest(
				bytes({
					FormatVersion: 1,
					Namespace: "N",
					Children: [
						{
							Source: { Text: "Source", Note: "manifest" },
							Keys: [{ Key: "K", Path: "a" }]
						}
					]
				})
			)
		)
	);
	for (const translation of ["First culture", "Second culture"]) {
		const archive = projection.archive(
			success(
				parseArchive(
					bytes({
						FormatVersion: 2,
						Namespace: "N",
						Children: [
							{
								Source: { Text: "Source", Note: "archive" },
								Key: "K",
								Translation: { Text: translation }
							}
						]
					})
				)
			)
		);
		for (const pending of [translation, "Pending edit"]) {
			const document = success(
				parsePO(
					new TextEncoder().encode(
						`#. Key: K\nmsgctxt "N,K"\nmsgid "Source"\nmsgstr "${pending}"\n`
					)
				)
			);
			const compact = projectPOEvidence(document);
			expect(projection.po(compact, archive)).toEqual(compact);
			expect(projection.po(compact, undefined)).toEqual(compact);
		}
		expect(archive.entries[0]?.source.Note).toBe("archive");
		expect(archive.entries[0]?.translation.Text).toBe(translation);
	}
	expect(manifest.entries[0]?.source.Note).toBe("manifest");
});
