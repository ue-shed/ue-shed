import type {
	BlueprintGraphRead,
	BlueprintPinReference,
	LevelSequenceRead,
	SavedPropertyValue,
	SequenceTrack
} from "@ue-shed/protocol";
import { Predicate, Schema } from "effect";
import {
	BlueprintGraphRead as BlueprintReadSchema,
	LevelSequenceRead as SequenceReadSchema
} from "@ue-shed/protocol";

export const SavedReviewReference = Schema.Struct({
	ownerPath: Schema.String,
	propertyPath: Schema.String,
	targetPath: Schema.String,
	targetRow: Schema.optionalKey(Schema.String)
});
export interface SavedReviewReference extends Schema.Schema.Type<typeof SavedReviewReference> {}

export const SavedReviewAsset = Schema.Struct({
	packageName: Schema.String,
	assetPath: Schema.String,
	kind: Schema.Literals(["blueprint", "level_sequence", "other"])
});
export interface SavedReviewAsset extends Schema.Schema.Type<typeof SavedReviewAsset> {}

export const SavedReferenceResolution = Schema.Union([
	Schema.Struct({ status: Schema.Literal("internal"), targetPath: Schema.String }),
	Schema.Struct({ status: Schema.Literal("native"), targetPath: Schema.String }),
	Schema.Struct({
		status: Schema.Literal("resolved"),
		asset: SavedReviewAsset,
		targetPath: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("ambiguous"),
		candidates: Schema.Array(SavedReviewAsset),
		targetPath: Schema.String
	}),
	Schema.Struct({ status: Schema.Literal("unavailable"), targetPath: Schema.String })
]);
export type SavedReferenceResolution = Schema.Schema.Type<typeof SavedReferenceResolution>;

/** Resolve only against an explicit inventory. Never construct a disk path from an object path. */
export function resolveSavedReference(
	targetPath: string,
	sourceObjectPath: string,
	inventory: readonly SavedReviewAsset[]
): SavedReferenceResolution {
	const packageName = targetPath.split(/[.:]/, 1)[0];
	if (packageName === sourceObjectPath.split(/[.:]/, 1)[0])
		return { status: "internal", targetPath };
	if (targetPath.startsWith("/Script/")) return { status: "native", targetPath };
	const candidates = inventory.filter((asset) => asset.packageName === packageName);
	const unique = [...new Map(candidates.map((asset) => [asset.assetPath, asset])).values()];
	const asset = unique[0];
	if (unique.length === 1 && asset !== undefined)
		return { status: "resolved", asset, targetPath };
	return unique.length > 1
		? { status: "ambiguous", candidates: unique, targetPath }
		: { status: "unavailable", targetPath };
}

export function blueprintReferences(read: BlueprintGraphRead): readonly SavedReviewReference[] {
	const references: SavedReviewReference[] = [];
	const add = (
		ownerPath: string,
		propertyPath: string,
		targetPath: string | null | undefined,
		targetRow?: string
	) => {
		if (targetPath && targetPath.startsWith("/"))
			references.push({
				ownerPath,
				propertyPath,
				targetPath,
				...(targetRow === undefined ? undefined : { targetRow })
			});
	};
	const visit = (owner: string, path: string, value: SavedPropertyValue): void => {
		switch (value.value_kind) {
			case "object_ref":
			case "soft_object_path":
				add(owner, path, value.value);
				break;
			case "data_table_row_handle":
				add(owner, path, value.table_object_path, value.row_name);
				break;
			case "struct":
				value.properties.forEach((child) => visit(owner, `${path}.${child.name}`, child));
				break;
			case "native_struct":
				value.fields.forEach((child) => visit(owner, `${path}.${child.name}`, child.value));
				break;
			case "instanced_struct":
				add(owner, `${path}.struct_type`, value.struct_type);
				if (value.value) visit(owner, `${path}.value`, value.value);
				break;
			case "array":
			case "set":
				value.values.forEach((child, index) => visit(owner, `${path}[${index}]`, child));
				break;
			case "map":
				value.entries.forEach((entry, index) => {
					visit(owner, `${path}[${index}].key`, entry.key);
					visit(owner, `${path}[${index}].value`, entry.value);
				});
				break;
		}
	};
	const definition = read.blueprint.definition;
	add(read.blueprint.object_path, "parent_class", definition.parent_class);
	for (const variable of definition.variables ?? []) {
		const path = `variables.${variable.name ?? variable.guid ?? "unknown"}`;
		add(read.blueprint.object_path, `${path}.type`, variable.pin_type?.subcategory_object);
		add(
			read.blueprint.object_path,
			`${path}.value_type`,
			variable.pin_type?.value_type?.subcategory_object
		);
		add(
			read.blueprint.object_path,
			`${path}.member`,
			variable.pin_type?.member_reference.parent
		);
		variable.properties.forEach((property) =>
			visit(read.blueprint.object_path, `${path}.${property.name}`, property)
		);
	}
	const savedObjects = [
		definition.default_object,
		...(definition.construction_script?.nodes.map((node) => node.template) ?? [])
	];
	for (const object of savedObjects) {
		if (!object) continue;
		add(object.object_path, "class", object.class_path);
		object.properties.forEach((property) => visit(object.object_path, property.name, property));
		if (object.native_data) visit(object.object_path, "$native_data", object.native_data);
	}
	for (const node of definition.construction_script?.nodes ?? []) {
		add(node.object_path, "component_class", node.component_class);
	}
	for (const graph of read.blueprint.graphs)
		for (const node of graph.nodes) {
			add(node.object_path, "class", node.class_path);
			node.properties.forEach((property) => visit(node.object_path, property.name, property));
			for (const pin of node.pins) {
				const path = `pins.${pin.name}`;
				add(node.object_path, `${path}.default_object`, pin.default_object);
				add(node.object_path, `${path}.type`, pin.pin_type.subcategory_object);
				add(
					node.object_path,
					`${path}.value_type`,
					pin.pin_type.value_type?.subcategory_object
				);
				add(node.object_path, `${path}.member`, pin.pin_type.member_reference.parent);
			}
		}
	return references.toSorted((a, b) => compareText(canonical(json(a)), canonical(json(b))));
}

export function sequenceReferences(read: LevelSequenceRead): readonly SavedReviewReference[] {
	return read.sequence.references.map((reference) => ({
		ownerPath: reference.owner_path,
		propertyPath: reference.property_path,
		targetPath: reference.target_path,
		...(reference.target_row === undefined ? undefined : { targetRow: reference.target_row })
	}));
}

export const SavedReviewChange = Schema.Struct({
	path: Schema.String,
	category: Schema.Literals(["structure", "value", "layout", "connection"]),
	kind: Schema.Literals(["added", "removed", "changed"]),
	before: Schema.optionalKey(Schema.Json),
	after: Schema.optionalKey(Schema.Json)
});
export interface SavedReviewChange extends Schema.Schema.Type<typeof SavedReviewChange> {}

export const SavedReviewComparison = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	domain: Schema.Literals(["blueprint", "level_sequence"]),
	beforeObjectPath: Schema.String,
	afterObjectPath: Schema.String,
	outcome: Schema.Literals(["complete", "partial"]),
	changes: Schema.Array(SavedReviewChange).check(Schema.isMaxLength(5000)),
	warnings: Schema.Array(Schema.String),
	truncated: Schema.Boolean
});
export interface SavedReviewComparison extends Schema.Schema.Type<typeof SavedReviewComparison> {}

/** Versioned JSON output shared by the public CLI's saved inspection and comparison commands. */
export const SavedReviewOutput = Schema.Union([
	Schema.Struct({
		schemaVersion: Schema.Literal(1),
		path: Schema.String,
		...BlueprintReadSchema.fields,
		references: Schema.Array(SavedReviewReference)
	}),
	Schema.Struct({
		schemaVersion: Schema.Literal(1),
		path: Schema.String,
		...SequenceReadSchema.fields,
		references: Schema.Array(SavedReviewReference)
	}),
	Schema.Struct({
		...SavedReviewComparison.fields,
		beforePath: Schema.String,
		afterPath: Schema.String
	})
]).annotate({ identifier: "SavedReviewOutput" });
export type SavedReviewOutput = Schema.Schema.Type<typeof SavedReviewOutput>;

type Evidence = Map<string, { category: SavedReviewChange["category"]; value: Schema.Json }>;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value: Schema.Json): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value instanceof Object)
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([a], [b]) => compareText(a, b))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
};
const json = <A>(value: A): Schema.Json =>
	Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));
const relative = (path: string, root: string) =>
	path === root
		? "$asset"
		: path.startsWith(`${root}.`) || path.startsWith(`${root}:`)
			? `$asset${path.slice(root.length)}`
			: path;
const id = (guid: string | undefined, fallback: string) =>
	guid && !/^0+-?0*-?0*-?0*$/.test(guid) ? guid : fallback;
const segment = (value: string) => encodeURIComponent(value);

function normalized(
	value: Schema.Json,
	root: string,
	aliases: readonly (readonly [string, string])[] = []
): Schema.Json {
	const path = (value: string) => {
		for (const [source, target] of aliases) {
			const result = relative(value, source);
			if (result !== value) return result.replace("$asset", target);
		}
		return relative(value, root);
	};
	if (Array.isArray(value)) return value.map((item) => normalized(item, root, aliases));
	if (!(value instanceof Object)) return value;
	const record = Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, normalized(child, root, aliases)])
	);
	for (const key of [
		"default_object",
		"subcategory_object",
		"table_object_path",
		"struct_type",
		"parent",
		"object_path",
		"class_path",
		"soft_path",
		"hard_path"
	]) {
		if (Predicate.isString(record[key])) record[key] = path(record[key]);
	}
	if (
		["object_ref", "soft_object_path"].includes(String(record.value_kind)) &&
		Predicate.isString(record.value)
	)
		record.value = path(record.value);
	if (record.value_kind === "set" && Array.isArray(record.values))
		record.values.sort((a, b) => compareText(canonical(a), canonical(b)));
	if (record.value_kind === "map" && Array.isArray(record.entries))
		record.entries.sort((a, b) => compareText(canonical(a), canonical(b)));
	if (record.value_kind === "struct" && Array.isArray(record.properties))
		record.properties.sort((a, b) => compareText(canonical(a), canonical(b)));
	return record;
}

function add<A>(
	evidence: Evidence,
	warnings: string[],
	path: string,
	category: SavedReviewChange["category"],
	value: A
) {
	let unique = path;
	if (evidence.has(unique)) {
		warnings.push(`Duplicate saved identity at ${path}; matching is ambiguous.`);
		let index = 2;
		while (evidence.has(unique)) unique = `${path}#${index++}`;
	}
	evidence.set(unique, { category, value: json(value) });
}

function blueprintEvidence(read: BlueprintGraphRead, warnings: string[]): Evidence {
	const evidence: Evidence = new Map();
	const root = read.blueprint.object_path;
	const definition = read.blueprint.definition;
	// The package portion also covers the proven generated class and its CDO, whose
	// paths are siblings of the Blueprint export rather than children of it.
	const packageRoot = root.split(/[.:]/, 1)[0] ?? root;
	const aliases: (readonly [string, string])[] = [[root, "$asset"]];
	if (definition.default_object)
		aliases.push(
			[definition.default_object.object_path, "$default_object"],
			[definition.default_object.class_path, "$generated_class"]
		);
	const normalizeDefinition = (value: Schema.Json) => normalized(value, packageRoot, aliases);
	add(evidence, warnings, "definition", "structure", {
		parent_class: definition.parent_class,
		variables_serialized: definition.variables !== null,
		default_object_available: definition.default_object !== null,
		construction_script_available: definition.construction_script !== null
	});
	for (const variable of definition.variables ?? []) {
		const path = `variables/${segment(id(variable.guid ?? undefined, variable.name ?? "unknown"))}`;
		add(evidence, warnings, path, "structure", { name: variable.name });
		add(
			evidence,
			warnings,
			`${path}/declaration`,
			"value",
			normalizeDefinition(
				json({
					pin_type: variable.pin_type,
					category: variable.category,
					property_flags: variable.property_flags,
					default_value: variable.default_value
				})
			)
		);
		for (const property of variable.properties) {
			if (["VarGuid", "VarName"].includes(property.name)) continue;
			add(
				evidence,
				warnings,
				`${path}/properties/${segment(property.name)}`,
				"value",
				normalizeDefinition(json(property))
			);
		}
	}
	const objectProperties = (
		path: string,
		object: NonNullable<typeof definition.default_object>
	) => {
		add(evidence, warnings, path, "structure", {
			class: normalizeDefinition(json({ class_path: object.class_path }))
		});
		if (object.native_data)
			add(
				evidence,
				warnings,
				`${path}/native_data`,
				"value",
				normalizeDefinition(json(object.native_data))
			);
		for (const property of object.properties)
			add(
				evidence,
				warnings,
				`${path}/properties/${segment(property.name)}`,
				"value",
				normalizeDefinition(json(property))
			);
	};
	if (definition.default_object) objectProperties("default_object", definition.default_object);
	const scs = definition.construction_script;
	if (scs) {
		const nodeIds = new Map(
			scs.nodes.map((node) => [
				node.object_path,
				id(
					node.guid ?? undefined,
					node.variable_name ?? relative(node.object_path, packageRoot)
				)
			])
		);
		const definitionPath = (path: string) => {
			for (const [source, target] of aliases) {
				const result = relative(path, source);
				if (result !== path) return result.replace("$asset", target);
			}
			return relative(path, packageRoot);
		};
		const refs = (paths: readonly string[] | null) =>
			paths?.map((path) => nodeIds.get(path) ?? definitionPath(path)) ?? null;
		add(evidence, warnings, "components/root_order", "connection", refs(scs.root_nodes));
		for (const node of scs.nodes) {
			const path = `components/${segment(nodeIds.get(node.object_path) ?? node.object_path)}`;
			add(evidence, warnings, path, "structure", {
				name: node.variable_name,
				class: node.component_class,
				attach_to_name: node.attach_to_name,
				parent_component_name: node.parent_component_name,
				parent_owner_class_name: node.parent_owner_class_name,
				parent_is_native: node.parent_is_native,
				template_available: node.template !== null
			});
			add(evidence, warnings, `${path}/children`, "connection", refs(node.children));
			if (node.template) objectProperties(`${path}/template`, node.template);
		}
	}
	for (const graph of read.blueprint.graphs) {
		const graphPath = `graphs/${segment(id(graph.guid, relative(graph.object_path, root)))}`;
		add(evidence, warnings, graphPath, "structure", { name: graph.name });
		const nodeIds = new Map(
			graph.nodes.map((node) => [
				node.object_path,
				id(node.guid, relative(node.object_path, root))
			])
		);
		const reference = (ref: BlueprintPinReference) => ({
			node:
				ref.node_object_path === undefined
					? null
					: (nodeIds.get(ref.node_object_path) ?? relative(ref.node_object_path, root)),
			pin: ref.pin_id
		});
		for (const node of graph.nodes) {
			const path = `${graphPath}/nodes/${segment(nodeIds.get(node.object_path) ?? node.object_path)}`;
			add(evidence, warnings, path, "structure", {
				class: node.class_path,
				kind: node.kind,
				title: node.title
			});
			add(evidence, warnings, `${path}/position`, "layout", node.position);
			for (const property of node.properties) {
				// These fields have dedicated identity/layout entries; reflected order is not semantic.
				if (["NodeGuid", "NodePosX", "NodePosY"].includes(property.name)) continue;
				add(
					evidence,
					warnings,
					`${path}/properties/${segment(property.name)}`,
					"value",
					normalized(json(property), root)
				);
			}
			for (const pin of node.pins) {
				const pinPath = `${path}/pins/${segment(pin.id)}`;
				const {
					linked_to: _links,
					source_index: _index,
					sub_pins,
					parent_pin,
					reference_pass_through_connection,
					...values
				} = pin;
				add(
					evidence,
					warnings,
					pinPath,
					"value",
					normalized(
						json({
							...values,
							sub_pins: sub_pins.map(reference),
							...(parent_pin ? { parent_pin: reference(parent_pin) } : undefined),
							...(reference_pass_through_connection
								? {
										reference_pass_through_connection: reference(
											reference_pass_through_connection
										)
									}
								: undefined)
						}),
						root
					)
				);
			}
		}
		for (const link of graph.links) {
			const value = { from: reference(link.from), to: reference(link.to) };
			add(
				evidence,
				warnings,
				`${graphPath}/links/${segment(canonical(json(value)))}`,
				"connection",
				value
			);
		}
	}
	return evidence;
}

function sequenceEvidence(read: LevelSequenceRead, warnings: string[]): Evidence {
	const evidence: Evidence = new Map();
	const sequence = read.sequence;
	add(evidence, warnings, "timing", "value", {
		tickResolution: sequence.tick_resolution,
		displayRate: sequence.display_rate,
		playbackRange: sequence.playback_range
	});
	const tracks = (items: readonly SequenceTrack[], owner: string) => {
		add(
			evidence,
			warnings,
			`${owner}/track_order`,
			"layout",
			items.map((track) => relative(track.object_path, sequence.object_path))
		);
		for (const track of items) {
			const path = `${owner}/tracks/${segment(relative(track.object_path, sequence.object_path))}`;
			add(evidence, warnings, path, "structure", {
				class: track.class_path,
				property: track.property_path,
				content: track.content
			});
			for (const section of track.sections) {
				const sectionPath = `${path}/sections/${segment(relative(section.object_path, sequence.object_path))}`;
				add(evidence, warnings, sectionPath, "structure", {
					class: section.class_path,
					sequence: section.sequence_path,
					shot: section.shot_display_name
				});
				add(evidence, warnings, `${sectionPath}/range`, "value", section.range);
				add(
					evidence,
					warnings,
					`${sectionPath}/settings`,
					"value",
					normalized(json(section.settings), sequence.object_path)
				);
				add(evidence, warnings, `${sectionPath}/camera_cut`, "value", section.camera_cut);
				for (const key of section.text_keys)
					add(evidence, warnings, `${sectionPath}/text/${key.frame}`, "value", key);
				for (const channel of section.numeric_channels) {
					const channelPath = `${sectionPath}/channels/${segment(channel.property_path)}`;
					const { keys, ...settings } = channel;
					add(evidence, warnings, channelPath, "value", settings);
					for (const key of keys)
						add(evidence, warnings, `${channelPath}/keys/${key.frame}`, "value", key);
				}
				for (const channel of section.discrete_channels) {
					const channelPath = `${sectionPath}/channels/${segment(channel.property_path)}`;
					const { keys, ...settings } = channel;
					add(evidence, warnings, channelPath, "value", {
						...settings,
						keys_serialized: keys !== null
					});
					for (const key of keys ?? [])
						add(evidence, warnings, `${channelPath}/keys/${key.frame}`, "value", key);
				}
				for (const channel of section.value_channels) {
					const channelPath = `${sectionPath}/channels/${segment(channel.property_path)}`;
					const { keys, ...settings } = channel;
					add(
						evidence,
						warnings,
						channelPath,
						"value",
						normalized(
							json({ ...settings, keys_serialized: keys !== null }),
							sequence.object_path
						)
					);
					for (const key of keys ?? [])
						add(
							evidence,
							warnings,
							`${channelPath}/keys/${key.frame}`,
							"value",
							normalized(json(key), sequence.object_path)
						);
				}
			}
		}
	};
	tracks(sequence.root_tracks, "root");
	for (const binding of sequence.bindings) {
		const path = `bindings/${segment(binding.id)}`;
		add(evidence, warnings, path, "structure", {
			name: binding.name,
			class: binding.possessed_object_class,
			kind: binding.kind,
			parent_id: binding.parent_id,
			object_template:
				binding.object_template === null
					? null
					: relative(binding.object_template, sequence.object_path),
			object_template_class: binding.object_template_class
		});
		tracks(binding.tracks, path);
	}
	for (const reference of sequence.references.filter((item) => item.scope === "external")) {
		add(
			evidence,
			warnings,
			`references/${segment(relative(reference.owner_path, sequence.object_path))}/${segment(reference.property_path)}`,
			"value",
			{ kind: reference.kind, target: reference.target_path, row: reference.target_row }
		);
	}
	return evidence;
}

function compare(
	domain: SavedReviewComparison["domain"],
	beforeObjectPath: string,
	afterObjectPath: string,
	before: Evidence,
	after: Evidence,
	warnings: string[]
): SavedReviewComparison {
	const changes: SavedReviewChange[] = [];
	let truncated = false;
	for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(compareText)) {
		const left = before.get(path),
			right = after.get(path);
		if (left && right && canonical(left.value) === canonical(right.value)) continue;
		if (changes.length === 5000) {
			truncated = true;
			break;
		}
		changes.push({
			path,
			category: right?.category ?? left?.category ?? "value",
			kind: !left ? "added" : !right ? "removed" : "changed",
			...(left ? { before: left.value } : undefined),
			...(right ? { after: right.value } : undefined)
		});
	}
	if (truncated) warnings.push("Change output reached its 5,000-entry limit.");
	return {
		schemaVersion: 1,
		domain,
		beforeObjectPath,
		afterObjectPath,
		outcome: warnings.length ? "partial" : "complete",
		changes,
		warnings: [...new Set(warnings)].sort(compareText),
		truncated
	};
}

export function compareSavedBlueprints(
	before: BlueprintGraphRead,
	after: BlueprintGraphRead
): SavedReviewComparison {
	const warnings: string[] = [];
	for (const [side, read] of [
		["Before", before],
		["After", after]
	] as const) {
		if (
			read.outcome === "partial" ||
			read.blueprint.coverage_gaps.length ||
			read.diagnostics.length
		)
			warnings.push(
				`${side} Blueprint has incomplete decoded evidence; unseen changes may exist.`
			);
	}
	return compare(
		"blueprint",
		before.blueprint.object_path,
		after.blueprint.object_path,
		blueprintEvidence(before, warnings),
		blueprintEvidence(after, warnings),
		warnings
	);
}

export function compareSavedSequences(
	before: LevelSequenceRead,
	after: LevelSequenceRead
): SavedReviewComparison {
	const warnings: string[] = [];
	for (const [side, read] of [
		["Before", before],
		["After", after]
	] as const) {
		if (
			read.outcome === "partial" ||
			read.sequence.coverage_gaps.length ||
			read.sequence.reference_coverage_gaps.length ||
			read.diagnostics.length
		)
			warnings.push(
				`${side} sequence has incomplete decoded evidence; unseen changes may exist.`
			);
	}
	return compare(
		"level_sequence",
		before.sequence.object_path,
		after.sequence.object_path,
		sequenceEvidence(before, warnings),
		sequenceEvidence(after, warnings),
		warnings
	);
}
