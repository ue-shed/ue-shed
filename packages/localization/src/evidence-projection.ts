import { immutable } from "./decode.js";
import {
	TextKey,
	TextNamespace,
	type LocalizationArchive,
	type LocalizationManifest,
	type LocalizationText,
	type POEvidence
} from "./schema.js";

/** Share repeated source context within one read; translations remain culture-specific. */
export function makeEvidenceProjection() {
	const strings = new Map<string, string>();
	const sources = new Map<string, LocalizationText>();
	const identities = new Map<string, NonNullable<POEvidence["entries"][number]["identity"]>>();
	const intern = (value: string): string => {
		const previous = strings.get(value);
		if (previous !== undefined) return previous;
		strings.set(value, value);
		return value;
	};
	const source = (value: LocalizationText): LocalizationText => {
		const key = JSON.stringify(value);
		const previous = sources.get(key);
		if (previous !== undefined) return previous;
		const result = immutable({ ...value, Text: intern(value.Text) });
		sources.set(key, result);
		return result;
	};
	const comments = (values: readonly string[]) =>
		values.length === 0 ? values : values.map(intern);
	const manifest = (value: LocalizationManifest): LocalizationManifest =>
		immutable({
			...value,
			entries: value.entries.map((entry) => ({ ...entry, source: source(entry.source) }))
		});
	const archive = (value: LocalizationArchive): LocalizationArchive =>
		immutable({
			...value,
			entries: value.entries.map((entry) => ({
				...entry,
				source: source(entry.source),
				key: TextKey.make(intern(entry.key))
			}))
		});
	const po = (value: POEvidence, archive: LocalizationArchive | undefined): POEvidence => {
		const translations = new Map<string, string>();
		for (const entry of archive?.entries ?? []) {
			translations.set(JSON.stringify([entry.namespace, entry.key]), entry.translation.Text);
		}
		return immutable({
			...value,
			entries: value.entries.map((entry) => {
				let identity = entry.identity;
				let msgstr = entry.msgstr;
				if (identity !== null) {
					const key = JSON.stringify([identity.namespace, identity.key]);
					const translation = translations.get(key);
					if (translation !== undefined && entry.msgstr["0"] === translation)
						msgstr = { ...entry.msgstr, "0": translation };
					const previous = identities.get(key);
					if (previous !== undefined) identity = previous;
					else {
						identity = {
							namespace: TextNamespace.make(intern(identity.namespace)),
							key: TextKey.make(intern(identity.key))
						};
						identities.set(key, identity);
					}
				}
				const result = {
					...entry,
					identity,
					msgstr,
					msgid: intern(entry.msgid),
					translatorComments: comments(entry.translatorComments),
					extractedComments: comments(entry.extractedComments),
					referenceComments: comments(entry.referenceComments),
					flags: comments(entry.flags),
					previousMsgidLines: comments(entry.previousMsgidLines)
				};
				if (entry.msgctxt !== undefined)
					Object.assign(result, { msgctxt: intern(entry.msgctxt) });
				if (entry.msgidPlural !== undefined)
					Object.assign(result, { msgidPlural: intern(entry.msgidPlural) });
				return result;
			})
		});
	};
	return { manifest, archive, po };
}
