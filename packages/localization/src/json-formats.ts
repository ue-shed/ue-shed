import { Schema } from "effect";
import {
	decodeJson,
	immutable,
	limitsFor,
	localizationError,
	parseResult,
	validate
} from "./decode.js";
import {
	ArchiveEntry,
	type LocalizationArchive,
	type LocalizationManifest,
	LocalizationText,
	type ManifestEntry,
	OpaqueRecord,
	TextKey,
	TextNamespace,
	type DuplicateIdentityDiagnostic,
	type LocalizationIdentity,
	type LocalizationLimits
} from "./schema.js";

const ManifestKey = Schema.Struct({
	Key: TextKey,
	Path: Schema.String,
	Optional: Schema.optionalKey(Schema.Boolean),
	MetaData: Schema.optionalKey(OpaqueRecord),
	DevNotes: Schema.optionalKey(Schema.String)
});
const ManifestChild = Schema.Struct({ Source: LocalizationText, Keys: Schema.Array(ManifestKey) });
const ArchiveChild = Schema.Struct({
	Source: LocalizationText,
	Translation: LocalizationText,
	Key: TextKey,
	Optional: Schema.optionalKey(Schema.Boolean),
	MetaData: Schema.optionalKey(OpaqueRecord)
});
const NamespaceFields = Schema.Struct({ Namespace: Schema.String });
function treeFields<Child extends Schema.Json>(child: Schema.Codec<Child, unknown>) {
	return NamespaceFields.pipe(
		Schema.fieldsAssign({ Children: Schema.optionalKey(Schema.Array(child)) })
	);
}
// The recursive link needs an explicit type; leaf fields come from their wire schemas.
type TreeNode<Child extends Schema.Json> = ReturnType<typeof treeFields<Child>>["Type"] & {
	readonly Subnamespaces?: readonly TreeNode<Child>[];
};
function treeSchema<Child extends Schema.Json>(
	child: Schema.Codec<Child, unknown>
): Schema.Codec<TreeNode<Child>, unknown> {
	const node: Schema.Codec<TreeNode<Child>, unknown> = Schema.suspend(() =>
		treeFields(child).pipe(
			Schema.fieldsAssign({
				Subnamespaces: Schema.optionalKey(Schema.Array(node))
			})
		)
	);
	return node;
}
const ManifestTree = treeSchema(ManifestChild);
const ArchiveTree = treeSchema(ArchiveChild);

function identityKey(entry: LocalizationIdentity): string {
	return JSON.stringify([entry.namespace, entry.key]);
}

function compareIdentity(a: LocalizationIdentity, b: LocalizationIdentity): number {
	return a.namespace < b.namespace
		? -1
		: a.namespace > b.namespace
			? 1
			: a.key < b.key
				? -1
				: a.key > b.key
					? 1
					: 0;
}

function diagnostics(entries: readonly LocalizationIdentity[]): DuplicateIdentityDiagnostic[] {
	const groups = new Map<string, { identity: LocalizationIdentity; count: number }>();
	for (const entry of entries) {
		const id = identityKey(entry);
		const previous = groups.get(id);
		groups.set(id, { identity: entry, count: (previous?.count ?? 0) + 1 });
	}
	return [...groups.values()]
		.filter(({ count }) => count > 1)
		.map(({ identity, count }) => ({
			code: "duplicate_identity",
			namespace: identity.namespace,
			key: identity.key,
			count
		}));
}

function flatten<Child extends Schema.Json, A>(
	root: TreeNode<Child>,
	limits: LocalizationLimits,
	decode: (child: Child, namespace: TextNamespace) => readonly A[]
): A[] {
	const pending = [{ value: root, namespace: "", depth: 0 }];
	const entries: A[] = [];
	let nodes = 0;
	while (pending.length > 0) {
		const item = pending.pop();
		if (item === undefined) break;
		if (++nodes > limits.maxEntries || item.depth > limits.maxDepth)
			throw localizationError("limit_exceeded");
		const node = item.value;
		const namespace = validate(
			TextNamespace,
			item.namespace === "" ? node.Namespace : `${item.namespace}.${node.Namespace}`
		);
		for (const child of node.Children ?? []) {
			for (const entry of decode(child, namespace)) {
				entries.push(entry);
				if (entries.length > limits.maxEntries) throw localizationError("limit_exceeded");
			}
		}
		for (const value of [...(node.Subnamespaces ?? [])].reverse()) {
			pending.push({ value, namespace, depth: item.depth + 1 });
		}
	}
	return entries;
}

export function parseManifest(bytes: Uint8Array, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		const root = decodeJson(bytes, limits, ManifestTree, 1);
		const entries = flatten<typeof ManifestChild.Type, ManifestEntry>(
			root,
			limits,
			(child, namespace) =>
				child.Keys.map((key): ManifestEntry => {
					const entry: ManifestEntry = {
						namespace,
						key: key.Key,
						source: child.Source,
						path: key.Path
					};
					if (key.Optional !== undefined)
						Object.assign(entry, { optional: key.Optional });
					if (key.MetaData !== undefined)
						Object.assign(entry, { metadata: key.MetaData });
					if (key.DevNotes !== undefined)
						Object.assign(entry, { devNotes: key.DevNotes });
					return entry;
				})
		).sort(compareIdentity);
		const manifest: LocalizationManifest = {
			formatVersion: 1,
			entries,
			diagnostics: diagnostics(entries)
		};
		return immutable(manifest);
	});
}

export function parseArchive(bytes: Uint8Array, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		const root = decodeJson(bytes, limits, ArchiveTree, 2);
		const entries = flatten<typeof ArchiveChild.Type, ArchiveEntry>(
			root,
			limits,
			(child, namespace) => {
				const entry: ArchiveEntry = {
					namespace,
					key: child.Key,
					source: child.Source,
					translation: child.Translation
				};
				if (child.Optional !== undefined)
					Object.assign(entry, { optional: child.Optional });
				if (child.MetaData !== undefined)
					Object.assign(entry, { metadata: child.MetaData });
				return [entry];
			}
		).sort(compareIdentity);
		const archive: LocalizationArchive = {
			formatVersion: 2,
			entries,
			diagnostics: diagnostics(entries)
		};
		return immutable(archive);
	});
}
