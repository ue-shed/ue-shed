import { Schema, SchemaRepresentation, type JsonSchema } from "effect";

const WireJsonObject = Schema.Record(Schema.String, Schema.Json);
const isSchemaObject = Schema.is(WireJsonObject);
const decodeWireJsonObject = Schema.decodeUnknownSync(WireJsonObject);
const isString: (value: Schema.Json | undefined) => value is string = Schema.is(Schema.String);

function normalizeWireJsonSchema(schema: JsonSchema.JsonSchema): Schema.JsonObject {
	const parsed = decodeWireJsonObject(schema);
	const visit = (value: Schema.Json): Schema.Json => {
		if (Array.isArray(value)) return value.map(visit);
		return isSchemaObject(value) ? normalizeWireJsonSchema(value) : value;
	};
	const output = Object.fromEntries(
		Object.entries(parsed).map(([key, value]) => [
			key,
			[
				"properties",
				"patternProperties",
				"$defs",
				"definitions",
				"dependentSchemas"
			].includes(key) && isSchemaObject(value)
				? Object.fromEntries(
						Object.entries(value).map(([name, child]) => [name, visit(child)])
					)
				: ["const", "default", "examples", "enum"].includes(key)
					? value
					: visit(value)
		])
	);

	const checks: JsonSchema.JsonSchema[] = [];
	for (const key of [
		"minimum",
		"exclusiveMinimum",
		"maximum",
		"exclusiveMaximum",
		"minItems",
		"maxItems",
		"minLength",
		"maxLength",
		"pattern"
	]) {
		if (key in output) {
			checks.push({ [key]: output[key] });
			delete output[key];
		}
	}
	if (checks.length > 0)
		output.allOf = [...checks, ...(Array.isArray(output.allOf) ? output.allOf : [])];
	if (Array.isArray(output.anyOf)) {
		output.anyOf = output.anyOf.flatMap((member: Schema.Json) =>
			isSchemaObject(member) &&
			member.type === "string" &&
			Array.isArray(member.enum) &&
			member.enum.join(",") === "NaN,Infinity,-Infinity"
				? member.enum.map((literal: Schema.Json) => ({ type: "string", enum: [literal] }))
				: [member]
		);
	}
	if (Array.isArray(output.allOf)) {
		output.allOf = output.allOf.filter(
			(clause: Schema.Json) => !isSchemaObject(clause) || Object.keys(clause).length > 0
		);
		if (Array.isArray(output.allOf) && output.allOf.length === 0) delete output.allOf;
	}
	return output;
}
// The wire contracts already choose their integer bounds. Do not add the compiler's
// implicit JavaScript-safe range over those language-neutral constraints.
function wireRepresentation(
	value: SchemaRepresentation.Representation
): SchemaRepresentation.Representation {
	const check = (value: SchemaRepresentation.Check): SchemaRepresentation.Check => {
		if (value.representation?.id === "effect/schema/isInt")
			return {
				...value,
				annotations: { ...value.annotations, toJsonSchema: () => ({ type: "integer" }) }
			};
		if (value._tag === "FilterGroup") {
			const [first, ...rest] = value.checks;
			return { ...value, checks: [check(first), ...rest.map(check)] };
		}
		return value;
	};
	switch (value._tag) {
		case "Reference":
			return value;
		case "Suspend":
			return { ...value, thunk: wireRepresentation(value.thunk) };
		case "Arrays":
			return {
				...value,
				checks: value.checks.map(check),
				elements: value.elements.map((item) => ({
					...item,
					type: wireRepresentation(item.type)
				})),
				rest: value.rest.map(wireRepresentation)
			};
		case "Objects":
			return {
				...value,
				checks: value.checks.map(check),
				propertySignatures: value.propertySignatures.map((item) => ({
					...item,
					type: wireRepresentation(item.type)
				})),
				indexSignatures: value.indexSignatures.map((item) => ({
					...item,
					parameter: wireRepresentation(item.parameter),
					type: wireRepresentation(item.type)
				}))
			};
		case "Union":
			return {
				...value,
				checks: value.checks.map(check),
				types: value.types.map(wireRepresentation)
			};
		case "Declaration":
			return {
				...value,
				checks: value.checks.map(check),
				typeParameters: value.typeParameters.map(wireRepresentation)
			};
		default:
			return { ...value, checks: value.checks.map(check) };
	}
}
/** Emit the established encoded wire representation, without canonical JSON codec conversions. */
export function makeWireJsonSchemaDocument(
	contract: Schema.Top,
	options?: SchemaRepresentation.ToRepresentationOptions
): JsonSchema.Document<"draft-2020-12"> {
	const representation = Schema.toRepresentation(contract, options);
	const document = SchemaRepresentation.toJsonSchemaDocument(
		{
			representation: wireRepresentation(representation.representation),
			references: Object.fromEntries(
				Object.entries(representation.references).map(([name, value]) => [
					name,
					wireRepresentation(value)
				])
			)
		},
		{
			onExcessProperty: "error"
		}
	);
	return {
		dialect: document.dialect,
		schema: normalizeWireJsonSchema(document.schema),
		definitions: Object.fromEntries(
			Object.entries(document.definitions).map(([name, schema]) => [
				name,
				normalizeWireJsonSchema(schema)
			])
		)
	};
}

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const isObject = Schema.is(JsonObject);
const decodeJsonObject = Schema.decodeUnknownSync(JsonObject);

/** Compare reachable schemas independently of definition names and redundant reference aliases. */
export function canonicalJsonSchemaReferences(input: JsonSchema.JsonSchema): Schema.Json {
	const document = decodeJsonObject(input);
	const definitions = isObject(document.$defs) ? document.$defs : {};
	const names = new Map<string, string>();
	const canonical: Record<string, Schema.Json> = {};
	const resolve = (name: string): string => {
		const seen = new Set<string>();
		while (true) {
			if (seen.has(name)) throw new Error(`Cyclic JSON Schema alias: ${name}`);
			seen.add(name);
			const definition = definitions[name];
			if (
				!isObject(definition) ||
				Object.keys(definition).length !== 1 ||
				!isString(definition.$ref) ||
				!definition.$ref.startsWith("#/$defs/")
			)
				return name;
			name = definition.$ref.slice("#/$defs/".length);
		}
	};
	const visit = (value: Schema.Json): Schema.Json => {
		if (Array.isArray(value)) return value.map(visit);
		if (!isObject(value)) return value;
		const output: Record<string, Schema.Json> = Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => {
					if (key !== "$ref" || !isString(item) || !item.startsWith("#/$defs/"))
						return [key, visit(item)];
					const name = resolve(item.slice("#/$defs/".length));
					const definition = definitions[name];
					if (definition === undefined)
						throw new Error(`Missing JSON Schema definition: ${name}`);
					let id = names.get(name);
					if (id === undefined) {
						id = `Definition${names.size}`;
						names.set(name, id);
						canonical[id] = visit(definition);
					}
					return [key, `#/$defs/${id}`];
				})
		);
		const constraints = new Set([
			"minimum",
			"maximum",
			"exclusiveMinimum",
			"exclusiveMaximum",
			"minLength",
			"maxLength",
			"minItems",
			"maxItems",
			"pattern"
		]);
		const clauses = (items: readonly Schema.Json[]): Schema.Json[] =>
			items.flatMap((clause) => {
				if (!isObject(clause)) return [clause];
				if (Object.keys(clause).length === 1 && Array.isArray(clause.allOf))
					return clauses(clause.allOf);
				if (Object.keys(clause).every((key) => constraints.has(key)))
					return Object.entries(clause).map(([key, item]) => ({ [key]: item }));
				return [clause];
			});
		if (Array.isArray(output.allOf))
			output.allOf = clauses(output.allOf).sort((a, b) =>
				JSON.stringify(a).localeCompare(JSON.stringify(b))
			);
		return output;
	};
	const root = { ...document };
	delete root.$defs;
	const schema = decodeJsonObject(visit(root));
	return { ...schema, $defs: canonical };
}
