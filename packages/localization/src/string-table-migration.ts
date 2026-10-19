import { GameTextAction, GameTextActionPlace } from "@ue-shed/protocol";
import { Schema } from "effect";
import {
	ConfigKey,
	ConfigSection,
	parseConfigFile,
	foldConfigCommands
} from "@ue-shed/config-explorer/browser";

const Field = Schema.String.check(Schema.isMaxLength(4096));
const Key = Schema.NonEmptyString.check(Schema.isMaxLength(4096));

/** Host-owned durable proposal identifier; claimed identifiers cannot be replayed. */
export const StringTableKeyMigrationId = Schema.NonEmptyString.check(Schema.isMaxLength(128)).pipe(
	Schema.brand("StringTableKeyMigrationId")
);
export type StringTableKeyMigrationId = typeof StringTableKeyMigrationId.Type;

/** Caller-supplied scope: discovery cannot prove the absence of dynamic/code references. */
export const StringTableKeyMigrationRequest = Schema.Struct({
	id: StringTableKeyMigrationId,
	projectRoot: Key,
	packageFile: Key,
	objectPath: Key,
	tableId: Key,
	namespace: Field,
	oldKey: Key,
	newKey: Key,
	source: Field,
	/** Optional reviewed deletion; omitted or false retains the old entry. */
	deleteOldEntry: Schema.optionalKey(Schema.Boolean),
	references: Schema.Array(Schema.Struct({ id: Key, place: GameTextActionPlace })).check(
		Schema.isMaxLength(254)
	)
});
export type StringTableKeyMigrationRequest = typeof StringTableKeyMigrationRequest.Type;

/** Non-mutating migration recipe. Persist and verify the redirect before approving removal. */
export const StringTableKeyMigrationPlan = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	request: StringTableKeyMigrationRequest,
	deleteOldEntry: Schema.Boolean,
	copy: GameTextAction,
	retarget: Schema.Array(GameTextAction),
	remove: GameTextAction,
	redirect: Schema.Struct({
		section: Schema.Literal("Core.StringTable"),
		configFile: Schema.Literal("Config/DefaultEngine.ini"),
		key: Schema.Literal("StringTableRedirects"),
		value: Schema.String,
		tableId: Key,
		oldKey: Key,
		newKey: Key,
		source: Field
	}),
	referenceCoverage: Schema.Literal("caller_supplied"),
	removeRequiresVerifiedRedirect: Schema.Literal(true)
});
export type StringTableKeyMigrationPlan = typeof StringTableKeyMigrationPlan.Type;

/** Builds explicit copy/configuration/retarget/remove phases; performs no IO or editor mutation. */
export function planStringTableKeyMigration(
	input: StringTableKeyMigrationRequest
):
	| { readonly status: "ready"; readonly plan: StringTableKeyMigrationPlan }
	| { readonly status: "invalid"; readonly message: string; readonly recovery: string } {
	const invalid = (message: string) => ({
		status: "invalid" as const,
		message,
		recovery: "Review the owning table, source, destination key and explicit reference list."
	});
	if (!Schema.is(StringTableKeyMigrationRequest)(input))
		return invalid("The migration request is invalid.");
	if (input.oldKey === input.newKey) return invalid("Choose a different destination key.");
	if ([input.tableId, input.oldKey, input.newKey].some((value) => /["\r\n]/u.test(value)))
		return invalid(
			"These identifiers cannot be represented by Unreal's quoted redirect syntax."
		);
	const ids = [
		input.id + ":copy",
		input.id + ":remove",
		...input.references.map((item) => item.id)
	];
	if (new Set(ids).size !== ids.length) return invalid("Migration action IDs must be unique.");
	if (input.references.some((item) => item.place.selector?.kind === "string_table_entry"))
		return invalid("A String Table entry is an owner, not a reference to retarget.");
	const expected = { namespace: input.namespace, key: input.oldKey, source: input.source };
	const place = {
		packageFile: input.packageFile,
		objectPath: input.objectPath,
		propertyPath: input.oldKey,
		selector: { kind: "string_table_entry" as const, entryKey: input.oldKey }
	};
	return {
		status: "ready",
		plan: {
			schemaVersion: 1,
			request: input,
			deleteOldEntry: input.deleteOldEntry === true,
			referenceCoverage: "caller_supplied",
			removeRequiresVerifiedRedirect: true,
			copy: {
				id: input.id + ":copy",
				place,
				expected,
				edit: {
					kind: "copy_string_table_entry",
					namespace: input.namespace,
					key: input.newKey,
					source: input.source
				}
			},
			retarget: input.references.map((item) => ({
				id: item.id,
				place: item.place,
				expected: {
					namespace: "",
					key: input.oldKey,
					tableId: input.tableId,
					source: input.source
				},
				edit: {
					kind: "retarget_string_table",
					tableId: input.tableId,
					key: input.newKey,
					source: input.source
				}
			})),
			remove: {
				id: input.id + ":remove",
				place,
				expected,
				edit: { kind: "remove_string_table_entry" }
			},
			redirect: {
				section: "Core.StringTable",
				configFile: "Config/DefaultEngine.ini",
				key: "StringTableRedirects",
				value: `(StringTable="${input.tableId}",OldKey="${input.oldKey}",NewKey="${input.newKey}")`,
				tableId: input.tableId,
				oldKey: input.oldKey,
				newKey: input.newKey,
				source: input.source
			}
		}
	};
}

/** Preserves config bytes around one additive Engine redirect and rejects a conflicting mapping. */
export function prepareStringTableRedirectConfig(
	before: string | undefined,
	redirect: StringTableKeyMigrationPlan["redirect"]
):
	| { readonly status: "ready"; readonly after: string }
	| { readonly status: "invalid"; readonly message: string } {
	const text = before ?? "";
	const parsed = parseConfigFile({
		text,
		source: { scope: "project", path: redirect.configFile },
		section: ConfigSection.make(redirect.section),
		key: ConfigKey.make(redirect.key)
	});
	if (parsed.diagnostics.length > 0)
		return {
			status: "invalid",
			message:
				"Existing String Table redirect configuration needs review before it can be changed."
		};
	const effective = foldConfigCommands(parsed.commands).effectiveValue;
	const values =
		effective.kind === "array"
			? effective.values
			: effective.kind === "scalar"
				? [effective.value]
				: [];
	// Unreal reads struct fields quoted or unquoted, so both must count as an existing redirect.
	const field = (value: string, name: string) => {
		const match = new RegExp(
			String.raw`(?:^|[,(\s])${name}\s*=\s*(?:"([^"\r\n]*)"|([^,)\s"]*))`,
			"iu"
		).exec(value);
		return match?.[1] ?? match?.[2];
	};
	const table = values.filter(
		(value) => field(value, "StringTable")?.toLowerCase() === redirect.tableId.toLowerCase()
	);
	// Unreal rejects a destination that redirects elsewhere; refuse it before anything is written.
	if (
		table.some(
			(value) =>
				field(value, "OldKey") === redirect.newKey &&
				field(value, "NewKey") !== redirect.newKey
		)
	)
		return {
			status: "invalid",
			message: "The new String Table key already redirects to another key."
		};
	for (const value of table) {
		if (field(value, "OldKey") !== redirect.oldKey) continue;
		if (field(value, "NewKey") === redirect.newKey) return { status: "ready", after: text };
		return {
			status: "invalid",
			message: "The old String Table key already has a different redirect."
		};
	}
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/(?<=\n)/u);
	let insertion: number | undefined;
	let inSection = false;
	for (let index = 0; index < lines.length; index++) {
		const header = /^\[([^\]]+)\]$/u.exec(lines[index]!.trim());
		if (!header) continue;
		if (inSection) insertion = index;
		inSection = header[1]!.toLowerCase() === redirect.section.toLowerCase();
		if (inSection) insertion = lines.length;
	}
	const command = `+${redirect.key}=${redirect.value}${newline}`;
	if (insertion === undefined)
		return {
			status: "ready",
			after:
				text +
				(text && !text.endsWith("\n") ? newline : "") +
				`[${redirect.section}]${newline}${command}`
		};
	const prefix = lines.slice(0, insertion).join("");
	return {
		status: "ready",
		after:
			prefix +
			(prefix && !prefix.endsWith("\n") ? newline : "") +
			command +
			lines.slice(insertion).join("")
	};
}
