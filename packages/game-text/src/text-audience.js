import { Schema } from "effect";
import { TextAudience as TextAudienceSchema, TextAudienceReason as TextAudienceReasonSchema, TextOutOfScopeReason } from "./text-audience-schema.js";
/** Whether a selected target's gather would collect the occurrence. */
export const TextGatherScope = Schema.Union([
    Schema.Struct({ status: Schema.Literals(["in_scope", "no_target"]) }),
    Schema.Struct({ status: Schema.Literal("out_of_scope"), reason: TextOutOfScopeReason }),
    Schema.Struct({ status: Schema.Literal("unknown") })
]);
/**
 * The version of how subjects are read and matched (property path normalization, name matching).
 * Bump it with any matcher change: indexes key their stored audience on it and the policy table.
 * 2: map entries (`Map{N}.value`) match as their map property.
 * Code places and the `macro` match changed no saved text's match, so they kept version 2.
 */
export const TEXT_AUDIENCE_MATCHER_VERSION = 2;
/**
 * The reviewed fallback policy, used when Unreal's gather table has no answer for an occurrence.
 * Rows apply in order; the first match wins. Editor rows come before player rows, so a K2 node
 * inside a Widget Blueprint graph stays editor text. Changes here change every project's counts:
 * document the evidence in the row's `why`, and keep `docs/products/game-text.md` in step.
 */
export const TEXT_AUDIENCE_POLICY = [
    {
        id: "developers_folder",
        audience: "editor",
        reason: "developer_folder",
        when: [{ kind: "folder", value: "/Game/Developers/" }],
        why: "Unreal's per-user developer folders; never cooked by default."
    },
    {
        id: "dev_folder",
        audience: "editor",
        reason: "developer_folder",
        when: [{ kind: "folder", value: "/Game/Dev/" }],
        why: "Conventional test and prototype content."
    },
    {
        id: "uobject_tooltips",
        audience: "editor",
        reason: "editor_namespace",
        when: [{ kind: "namespace", value: "UObjectToolTips" }],
        why: "Class and property tooltips from reflection metadata."
    },
    {
        id: "uobject_display_names",
        audience: "editor",
        reason: "editor_namespace",
        when: [{ kind: "namespace", value: "UObjectDisplayNames" }],
        why: "Class and property display names from reflection metadata."
    },
    {
        id: "uobject_categories",
        audience: "editor",
        reason: "editor_namespace",
        when: [{ kind: "namespace", value: "UObjectCategories" }],
        why: "Details panel categories from reflection metadata."
    },
    {
        id: "k2_node",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "K2Node_", position: "prefix" }],
        why: "Blueprint graph nodes: pin tooltips, comments, node titles."
    },
    {
        id: "anim_graph_node",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "AnimGraphNode_", position: "prefix" }],
        why: "Animation Blueprint graph nodes."
    },
    {
        id: "anim_state_node",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "AnimStateNode", position: "prefix" }],
        why: "Animation state machine graph nodes."
    },
    {
        id: "ed_graph",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "EdGraph", position: "prefix" }],
        why: "Editor graphs, schemas and comment nodes."
    },
    {
        id: "scs_node",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "SCS_Node", position: "prefix" }],
        why: "Blueprint component tree entries: categories and tooltips."
    },
    {
        id: "niagara_node",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "NiagaraNode", position: "prefix" }],
        why: "Niagara script graph nodes."
    },
    {
        id: "niagara_graph",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "NiagaraGraph", position: "prefix" }],
        why: "Niagara script graphs."
    },
    {
        id: "material_expression",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "MaterialExpression", position: "prefix" }],
        why: "Material graph expressions: descriptions and parameter groups."
    },
    {
        id: "material_graph",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "object", value: "MaterialGraph", position: "prefix" }],
        why: "Material editor graphs."
    },
    {
        id: "editor_module",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "module", value: "Editor", suffix: true }],
        why: "Classes from editor modules (`*Editor`), such as UMGEditor or NiagaraEditor."
    },
    {
        id: "unreal_ed_module",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "module", value: "UnrealEd" }],
        why: "Classes from the UnrealEd module."
    },
    {
        id: "blueprint_graph_module",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "module", value: "BlueprintGraph" }],
        why: "Blueprint graph classes."
    },
    {
        id: "anim_graph_module",
        audience: "editor",
        reason: "editor_object",
        when: [{ kind: "module", value: "AnimGraph" }],
        why: "Animation graph classes."
    },
    {
        id: "property_tooltip",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "PropertyTooltip" }],
        why: "Blueprint variable tooltips."
    },
    {
        id: "tooltip",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "ToolTip" }],
        why: "Editor tooltips on Blueprint functions, variables and graph pins."
    },
    {
        id: "pin_tooltip",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "PinToolTip" }],
        why: "Graph pin tooltips."
    },
    {
        id: "category",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "Category" }],
        why: "Details panel and palette categories."
    },
    {
        id: "category_name",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "CategoryName" }],
        why: "Blueprint and SCS category names."
    },
    {
        id: "palette_category",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "PaletteCategory" }],
        why: "The UMG designer palette category of a widget."
    },
    {
        id: "niagara_version_data",
        audience: "editor",
        reason: "editor_property",
        when: [
            { kind: "module", value: "Niagara" },
            { kind: "property", value: "VersionData", anywhere: true }
        ],
        why: "Niagara script version metadata: descriptions, categories and keywords for the editor."
    },
    {
        id: "niagara_cached_script_vm",
        audience: "editor",
        reason: "editor_property",
        when: [
            { kind: "module", value: "Niagara" },
            { kind: "property", value: "CachedScriptVM", anywhere: true }
        ],
        why: "Compiled Niagara script data cached with the asset."
    },
    {
        id: "objects_to_display_names",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "ObjectsToDisplayNames" }],
        why: "Editor display names for objects in a sequence or widget animation."
    },
    {
        id: "niagara_signature_description",
        audience: "editor",
        reason: "editor_property",
        when: [{ kind: "property", value: "Signature.Description" }],
        why: "Niagara function signature descriptions."
    },
    {
        id: "movie_scene_display_name",
        audience: "editor",
        reason: "editor_property",
        when: [
            { kind: "module", value: "MovieScene" },
            { kind: "property", value: "DisplayName" }
        ],
        why: "Sequencer track names, saved as editor-only data."
    },
    {
        id: "movie_scene_tracks_display_name",
        audience: "editor",
        reason: "editor_property",
        when: [
            { kind: "module", value: "MovieSceneTracks" },
            { kind: "property", value: "DisplayName" }
        ],
        why: "Sequencer track names, saved as editor-only data."
    },
    {
        id: "string_table",
        audience: "player",
        reason: "player_asset",
        when: [{ kind: "location", value: "string_table_entry" }],
        why: "String Table entries exist to be displayed."
    },
    {
        id: "data_table",
        audience: "player",
        reason: "player_asset",
        when: [{ kind: "location", value: "data_table_cell" }],
        why: "DataTable text cells are game data."
    },
    {
        id: "user_defined_enum_display_name",
        audience: "player",
        reason: "player_asset",
        when: [
            { kind: "object", value: "UserDefinedEnum", position: "equals" },
            { kind: "property", value: "DisplayNameMap" }
        ],
        why: "A Blueprint enum's display names, usually shown in menus and item text."
    },
    {
        id: "widget_tree",
        audience: "player",
        reason: "player_asset",
        when: [{ kind: "object", value: "WidgetTree", position: "equals" }],
        why: "Widgets placed in a Widget Blueprint's designer tree."
    },
    {
        id: "script_bytecode",
        audience: "player",
        reason: "player_asset",
        when: [{ kind: "property", value: "ScriptBytecode" }],
        why: "Text literals compiled into a Blueprint function's bytecode, which the game runs."
    },
    // Code rows come last, so the rows saved text can match keep their positions (stored codes).
    {
        id: "ui_command",
        audience: "editor",
        reason: "editor_namespace",
        when: [{ kind: "macro", value: "UI_COMMAND" }],
        why: "Slate command labels and tooltips, gathered under `UICommands.` namespaces."
    }
];
/**
 * The policy a code layer is keyed on, and the part package shards are keyed on: a `macro` row
 * can never hold for saved text, so adding one re-reads no package.
 */
export const TEXT_AUDIENCE_POLICY_KEY = JSON.stringify([
    TEXT_AUDIENCE_MATCHER_VERSION,
    TEXT_AUDIENCE_POLICY
]);
export const SAVED_TEXT_AUDIENCE_POLICY_KEY = JSON.stringify([
    TEXT_AUDIENCE_MATCHER_VERSION,
    TEXT_AUDIENCE_POLICY.filter((row) => !row.when.some((match) => match.kind === "macro"))
]);
/** Container indexes the reader appends to a property name: `[N]` for array and set elements,
 * `{N}` for map entries, and `("…")` for named entries. */
const PROPERTY_SUFFIX = /(?:\[[^\]]*\]|\{[^}]*\}|\("[^"]*"\))+$/u;
const MAP_ENTRY = /\{[^}]*\}$/u;
/**
 * A property path's property names, without container indexes. The reader writes a map entry's
 * key and value as `Map{N}.key` and `Map{N}.value`; those two elements name the entry, not a
 * property, so they are dropped and the text matches as the map property (`Map`).
 */
function propertyElements(path) {
    const elements = [];
    let afterMapEntry = false;
    for (const element of path.split(".")) {
        const mapEntrySide = afterMapEntry && (element === "key" || element === "value");
        afterMapEntry = MAP_ENTRY.test(element);
        if (mapEntrySide)
            continue;
        const name = element.replace(PROPERTY_SUFFIX, "");
        if (name !== "")
            elements.push(name);
    }
    return elements;
}
/** Splits an Unreal object path into its package and the object names below it. */
function objectParts(objectPath) {
    const dot = objectPath.indexOf(".", objectPath.lastIndexOf("/") + 1);
    const packagePath = dot < 0 ? objectPath : objectPath.slice(0, dot);
    const objects = dot < 0
        ? []
        : objectPath
            .slice(dot + 1)
            .split(/[.:]/u)
            .filter((name) => name !== "");
    return { packagePath, objects };
}
function subject(input) {
    const { packagePath, objects } = objectParts(input.objectPath);
    const classPath = input.classPath;
    const classDot = classPath?.lastIndexOf(".") ?? -1;
    const module = classPath?.startsWith("/Script/") && classDot > 0
        ? classPath.slice("/Script/".length, classDot)
        : undefined;
    return {
        namespace: input.namespace,
        packagePath,
        objects,
        className: classPath === undefined ? undefined : classPath.slice(classDot + 1),
        module,
        propertyPath: input.propertyPath,
        locationKind: input.locationKind,
        macro: input.macro
    };
}
/**
 * Normalizes occurrence facts for audience policy matching. This is a pure projection of saved
 * provenance and does not inspect a running editor or decide gather inclusion.
 */
export function textAudienceSubject(occurrence) {
    const location = occurrence.location;
    const namespace = occurrence.identity.status === "resolved" ? occurrence.identity.namespace : undefined;
    if (location.kind === "code_place")
        return subject({
            namespace,
            objectPath: "",
            classPath: undefined,
            propertyPath: "",
            locationKind: location.kind,
            macro: location.macro
        });
    return subject({
        namespace,
        objectPath: location.objectPath,
        classPath: location.kind === "asset_property" ? location.classPath : undefined,
        propertyPath: location.kind === "string_table_entry" ? "" : location.propertyPath,
        locationKind: location.kind
    });
}
/**
 * The same subject read straight from the reader's package record, so the index classifies the
 * occurrence it stores exactly as the corpus classifies the occurrence it builds from that record.
 */
export function savedTextAudienceSubject(occurrence) {
    const location = occurrence.location;
    const identity = occurrence.identity;
    return subject({
        // textOccurrenceFromExtraction leaves a resolved identity without a key unresolved.
        namespace: identity.status === "resolved" && identity.key.length > 0
            ? identity.namespace
            : undefined,
        objectPath: location.object_path,
        classPath: location.kind === "asset_property" ? location.class_path : undefined,
        propertyPath: location.kind === "string_table_entry" ? "" : location.property_path,
        locationKind: location.kind
    });
}
const lower = (value) => value.toLowerCase();
function prepare(subject) {
    return {
        namespace: subject.namespace?.toLowerCase(),
        folder: `${subject.packagePath.toLowerCase()}/`,
        className: subject.className?.toLowerCase(),
        objects: subject.objects.map(lower),
        module: subject.module?.toLowerCase(),
        elements: propertyElements(subject.propertyPath).map(lower),
        locationKind: subject.locationKind,
        macro: subject.macro?.toLowerCase()
    };
}
// Each row's match values, lowercased (and a property path split) once.
const loweredValues = new WeakMap();
function valuesOf(match) {
    let values = loweredValues.get(match);
    if (values === undefined) {
        const value = match.value.toLowerCase();
        values = match.kind === "property" && !match.anywhere ? value.split(".") : [value];
        loweredValues.set(match, values);
    }
    return values;
}
function matches(subject, match) {
    if (match.kind === "location")
        return subject.locationKind === match.value;
    const values = valuesOf(match);
    const value = values[0];
    switch (match.kind) {
        case "namespace":
            return subject.namespace === value;
        case "macro":
            return subject.macro === value;
        case "folder":
            return subject.folder.startsWith(value);
        case "object": {
            const named = (name) => match.position === "prefix"
                ? name.startsWith(value)
                : match.position === "suffix"
                    ? name.endsWith(value)
                    : name === value;
            return ((subject.className !== undefined && named(subject.className)) ||
                subject.objects.some(named));
        }
        case "module":
            return (subject.module !== undefined &&
                (match.suffix ? subject.module.endsWith(value) : subject.module === value));
        case "property": {
            const elements = subject.elements;
            if (match.anywhere)
                return elements.includes(value);
            if (elements.length < values.length)
                return false;
            const offset = elements.length - values.length;
            return values.every((wanted, index) => elements[offset + index] === wanted);
        }
    }
}
/** The first policy row that matches, or undefined. */
export function matchTextAudiencePolicy(subject, policy) {
    return firstRule(prepare(subject), policy);
}
function firstRule(prepared, policy) {
    return policy.find((rule) => rule.when.every((match) => matches(prepared, match)));
}
// Shared results: classifying allocates only its subject, and nothing with a gather-table bit.
const GATHER_TABLE_EDITOR_ONLY = {
    audience: "editor",
    reason: "gather_table_editor_only"
};
const GATHER_TABLE_RUNTIME = {
    audience: "player",
    reason: "gather_table_runtime"
};
const NO_EVIDENCE = { audience: "unknown", reason: "no_evidence" };
const RULE_RESULTS = new Map(TEXT_AUDIENCE_POLICY.map((rule) => [
    rule,
    { audience: rule.audience, reason: rule.reason, rule: rule.id }
]));
function gatherTableResult(editorOnly) {
    return editorOnly ? GATHER_TABLE_EDITOR_ONLY : GATHER_TABLE_RUNTIME;
}
function policyResult(subject) {
    const rule = firstRule(prepare(subject), TEXT_AUDIENCE_POLICY);
    return rule === undefined ? NO_EVIDENCE : RULE_RESULTS.get(rule);
}
/**
 * Classifies an occurrence from gather evidence and a policy table. Authoritative saved
 * editor-only bits take precedence; absent matching evidence remains unknown instead of
 * becoming a runtime assumption.
 */
export function classifyTextAudience(occurrence, evidence = {}) {
    return evidence.gatherTableEditorOnly === undefined
        ? policyResult(textAudienceSubject(occurrence))
        : gatherTableResult(evidence.gatherTableEditorOnly);
}
/** A reader package record's occurrence, with its gather-table bit when the reader sent one. */
export function classifySavedTextAudience(occurrence) {
    return occurrence.gather_editor_only === undefined
        ? policyResult(savedTextAudienceSubject(occurrence))
        : gatherTableResult(occurrence.gather_editor_only);
}
/**
 * The occurrence's audience: the one the corpus or index recorded, or the policy table's answer for
 * an occurrence built without one (no gather-table evidence).
 */
export function occurrenceTextAudience(occurrence) {
    if (occurrence.audience !== undefined && occurrence.audienceReason !== undefined) {
        const rule = TEXT_AUDIENCE_POLICY.find((row) => row.id === occurrence.audienceRule)?.id;
        return {
            audience: occurrence.audience,
            reason: occurrence.audienceReason,
            ...(rule === undefined ? undefined : { rule })
        };
    }
    return classifyTextAudience(occurrence);
}
/** The public occurrence fields for a classification. */
export function textAudienceFields(classification) {
    return {
        audience: classification.audience,
        audienceReason: classification.reason,
        ...(classification.rule === undefined ? undefined : { audienceRule: classification.rule })
    };
}
/**
 * Editor text a target that does not gather editor-only data would skip. Developer folders are
 * editor text by convention, not editor-only data, so their text stays in scope.
 */
export function isEditorOnlyText(classification) {
    return classification.audience === "editor" && classification.reason !== "developer_folder";
}
const AUDIENCE_RANK = { editor: 0, unknown: 1, player: 2 };
/** A line is player text if any occurrence is; otherwise unknown if any is; otherwise editor. */
export function lineTextAudience(audiences) {
    let best;
    for (const audience of audiences) {
        if (audience === "player")
            return audience;
        if (best === undefined || AUDIENCE_RANK[audience] > AUDIENCE_RANK[best])
            best = audience;
    }
    return best ?? "unknown";
}
// Compact index encoding, one u32 per occurrence: audience index in TextAudience (2 bits), reason
// index in TextAudienceReason (4 bits from bit 2), policy row index plus one (8 bits from bit 8; 0
// for none). Line, unit and slice rows store a mask of their occurrences' audiences (one bit per
// TextAudience index), and lines the out-of-scope reason's index plus one from bit 4.
const AUDIENCES = TextAudienceSchema.literals;
const REASONS = TextAudienceReasonSchema.literals;
/**
 * Encodes an audience classification into compact persisted bits. The rule position belongs to
 * the current policy table, so persisted consumers must keep policy version identity with their
 * data.
 */
export function encodeTextAudience(classification) {
    const rule = classification.rule === undefined
        ? 0
        : TEXT_AUDIENCE_POLICY.findIndex((row) => row.id === classification.rule) + 1;
    return (AUDIENCES.indexOf(classification.audience) |
        (REASONS.indexOf(classification.reason) << 2) |
        (rule << 8));
}
/**
 * Decodes the compact persisted audience/reason/policy-row code. Use the same policy
 * table/version that produced the code; it is not a durable substitute for authored policy
 * identities.
 */
export function decodeTextAudience(code) {
    const audience = AUDIENCES[code & 3];
    const reason = REASONS[(code >>> 2) & 15];
    const rule = (code >>> 8) & 255;
    if (audience === undefined || reason === undefined || rule > TEXT_AUDIENCE_POLICY.length)
        throw new Error(`Invalid text audience code ${code}.`);
    return rule === 0
        ? { audience, reason }
        : { audience, reason, rule: TEXT_AUDIENCE_POLICY[rule - 1].id };
}
/** isEditorOnlyText for an encoded occurrence. */
export function isEditorOnlyTextCode(code) {
    return ((code & 3) === AUDIENCES.indexOf("editor") &&
        ((code >>> 2) & 15) !== REASONS.indexOf("developer_folder"));
}
/** The audience bit for an encoded occurrence, for a row's audience mask. */
export function textAudienceBit(code) {
    return 1 << (code & 3);
}
/** A row's audience from its mask: player, else unknown, else editor; unknown when empty. */
export function textAudienceOfMask(mask) {
    return mask & 1 ? "player" : mask & 4 || !(mask & 2) ? "unknown" : "editor";
}
/**
 * Stable explanations for a selected target excluding saved text. Unknown gather scope remains
 * separate from an explicit exclusion, so hosts do not treat missing evidence as a negative
 * result.
 */
export const TEXT_OUT_OF_SCOPE_REASONS = TextOutOfScopeReason.literals;
