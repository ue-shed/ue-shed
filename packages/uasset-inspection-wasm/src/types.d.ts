export type FailureKind =
	| "malformed_data"
	| "resource_limit"
	| "unsupported_format"
	| "unsupported_version"
	| "unsupported_capability";

export interface InspectionDecodeError {
	readonly object_path: string;
	readonly class_path?: string;
	readonly kind: FailureKind;
	readonly message: string;
}

export type InspectionValue =
	| {
			readonly value_kind: "native_struct";
			readonly fields: readonly { readonly name: string; readonly value: InspectionValue }[];
	  }
	| {
			readonly value_kind: "instanced_struct";
			readonly struct_type: string | null;
			readonly size: number;
			readonly value: InspectionValue | null;
	  }
	| { readonly value_kind: "bool"; readonly value: boolean }
	| { readonly value_kind: "int"; readonly value: number }
	| { readonly value_kind: "uint"; readonly value: number }
	| { readonly value_kind: "float"; readonly value: number }
	| { readonly value_kind: "double"; readonly value: number }
	| {
			readonly value_kind: "name" | "enum" | "string" | "guid" | "soft_object_path";
			readonly value: string;
	  }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "none" | "base" | "string_table";
			readonly namespace?: string;
			readonly table_id?: string;
			readonly key?: string;
	  }
	| { readonly value_kind: "vector"; readonly x: number; readonly y: number; readonly z: number }
	| { readonly value_kind: "int_point"; readonly x: number; readonly y: number }
	| {
			readonly value_kind: "rotator";
			readonly pitch: number;
			readonly yaw: number;
			readonly roll: number;
	  }
	| {
			readonly value_kind: "color";
			readonly r: number;
			readonly g: number;
			readonly b: number;
			readonly a: number;
	  }
	| {
			readonly value_kind: "linear_color";
			readonly r: number;
			readonly g: number;
			readonly b: number;
			readonly a: number;
	  }
	| {
			readonly value_kind: "data_table_row_handle";
			readonly table_object_path: string | null;
			readonly row_name: string;
	  }
	| { readonly value_kind: "object_ref"; readonly value: string | null }
	| { readonly value_kind: "array" | "set"; readonly values: readonly InspectionValue[] }
	| {
			readonly value_kind: "map";
			readonly entries: readonly {
				readonly key: InspectionValue;
				readonly value: InspectionValue;
			}[];
	  }
	| { readonly value_kind: "struct"; readonly properties: readonly InspectionProperty[] }
	| { readonly value_kind: "raw"; readonly reason: string; readonly size: number };

export type InspectionProperty = InspectionValue & {
	readonly name: string;
	readonly type: string;
};

export interface InspectionAsset {
	readonly reference_pose?: InspectionValue;
	readonly kind: string;
	readonly object_path: string;
	readonly class_path?: string;
	readonly object_guid?: string;
	readonly row_struct?: string;
	readonly parent_tables?: readonly string[];
	readonly string_table_namespace?: string;
	readonly string_table_metadata?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly string_table_entries?: readonly { readonly key: string; readonly source: string }[];
	readonly enum_cpp_form?: string;
	readonly enum_entries?: readonly {
		readonly name: string;
		readonly value: number;
		readonly display_name?: string;
	}[];
	readonly struct_flags?: number;
	readonly struct_fields?: readonly {
		readonly name: string;
		readonly type: string;
		readonly referenced_path?: string;
		readonly display_name?: string;
	}[];
	readonly properties: readonly InspectionProperty[];
	readonly native_data?: InspectionValue;
	readonly tail_bytes?: number;
	readonly bones: readonly { readonly name: string; readonly parent_index: number }[];
	readonly row_count: number;
	readonly curve_rows: readonly {
		readonly name: string;
		readonly keys: readonly { readonly time: number; readonly value: number }[];
	}[];
	readonly rows: readonly {
		readonly name: string;
		readonly properties: readonly InspectionProperty[];
	}[];
}

export interface InspectionPackage {
	readonly name: string;
	readonly version: {
		readonly legacy_file: number;
		readonly legacy_ue3: number | null;
		readonly ue4: number;
		readonly ue5: number;
		readonly licensee: number;
	};
	readonly package_flags: number;
	readonly summary_size: number;
	readonly total_header_size: number;
	readonly names: { readonly count: number; readonly offset: number };
	readonly soft_object_paths?: {
		readonly count: number;
		readonly offset: number;
		readonly parsed_count: number;
	};
	readonly imports: { readonly count: number; readonly offset: number };
	readonly exports: { readonly count: number; readonly offset: number };
}

export interface InspectionSuccess {
	readonly metadata?: {
		readonly root: Readonly<Record<string, string>>;
		readonly objects: Readonly<Record<string, Readonly<Record<string, string>>>>;
	};
	readonly schema_version: 8;
	readonly status: "ok" | "partial";
	readonly path: string;
	readonly package: InspectionPackage;
	readonly assets: readonly InspectionAsset[];
	readonly decode_errors?: readonly InspectionDecodeError[];
}

export interface InspectionError {
	readonly schema_version: 8;
	readonly status: "error";
	readonly path: string;
	readonly kind: FailureKind | "internal";
	readonly message: string;
	readonly field: string | null;
	readonly offset: number | null;
}

export type InspectionResult = InspectionSuccess | InspectionError;

export interface TextOccurrence {
	readonly source: string;
	readonly identity:
		| { readonly status: "resolved"; readonly namespace: string; readonly key: string }
		| { readonly status: "string_table"; readonly table_id: string; readonly key: string }
		| { readonly status: "unresolved"; readonly reason: "culture_invariant" | "missing_key" };
	readonly location:
		| {
				readonly kind: "data_table_cell";
				readonly object_path: string;
				readonly row: string;
				readonly property_path: string;
		  }
		| {
				readonly kind: "string_table_entry";
				readonly object_path: string;
				readonly entry_key: string;
		  }
		| {
				readonly kind: "asset_property";
				readonly object_path: string;
				readonly class_path: string;
				readonly property_path: string;
		  };
	readonly edit_capability: "source_editable" | "read_only";
}

export interface TextCoverageGap {
	readonly object_path: string;
	readonly property_path: string;
	readonly reason: "unsupported_text_history";
}

export interface ProjectionDiagnostic {
	readonly object_path: string;
	readonly class_path?: string;
	readonly code: FailureKind;
	readonly message: string;
}

export interface TextProjection {
	readonly schema_version: 1;
	readonly status: "complete" | "partial";
	readonly path: string;
	readonly occurrences: readonly TextOccurrence[];
	readonly coverage_gaps: readonly TextCoverageGap[];
	readonly diagnostics: readonly ProjectionDiagnostic[];
}

export interface TextureEvidence<T> {
	readonly status: "available" | "unavailable";
	readonly source?: "serialized" | "file";
	readonly value?: T;
	readonly reason?: "not_serialized" | "wrong_value_kind" | "missing_source";
}

export interface TextureRecord {
	readonly object_path: string;
	readonly package_file_bytes: TextureEvidence<number>;
	readonly dimensions: TextureEvidence<{ readonly width: number; readonly height: number }>;
	readonly source_format: TextureEvidence<string>;
	readonly source_mips: TextureEvidence<number>;
	readonly compression: TextureEvidence<string>;
	readonly s_rgb: TextureEvidence<boolean>;
	readonly texture_group: TextureEvidence<string>;
	readonly mip_generation: TextureEvidence<string>;
}

export interface TextureProjection {
	readonly schema_version: 1;
	readonly status: "complete" | "partial";
	readonly path: string;
	readonly records: readonly TextureRecord[];
	readonly diagnostics: readonly ProjectionDiagnostic[];
}

export interface ProjectionError {
	readonly schema_version: 1;
	readonly status: "error";
	readonly path: string;
	readonly kind: FailureKind | "internal";
	readonly message: string;
}

export type TextResult = TextProjection | ProjectionError;
export type TextureResult = TextureProjection | ProjectionError;

export interface LevelSequenceFrameRate {
	readonly numerator: number;
	readonly denominator: number;
}

export interface LevelSequenceFrameRange {
	readonly lower: { readonly kind: "exclusive" | "inclusive" | "open"; readonly frame: number };
	readonly upper: { readonly kind: "exclusive" | "inclusive" | "open"; readonly frame: number };
}

export interface LevelSequenceTextKey {
	readonly frame: number;
	readonly source: string;
	readonly identity:
		| { readonly status: "resolved"; readonly namespace: string; readonly key: string }
		| { readonly status: "unresolved" };
}

export interface LevelSequenceSection {
	readonly object_path: string;
	readonly class_path: string;
	readonly range: LevelSequenceFrameRange | null;
	readonly sequence_path: string | null;
	readonly shot_display_name: string | null;
	readonly text_keys: readonly LevelSequenceTextKey[];
	readonly numeric_channels: readonly LevelSequenceNumericChannel[];
	readonly discrete_channels: readonly LevelSequenceDiscreteChannel[];
	readonly value_channels: readonly SequenceValueChannel[];
	readonly settings: SequenceSectionSettings;
	readonly camera_cut: SequenceCameraCut | null;
}

export interface LevelSequenceDiscreteChannelData<T> {
	readonly property_path: string;
	readonly has_default_value: boolean | null;
	readonly default_value: T | null;
	readonly pre_extrapolation: string | null;
	readonly post_extrapolation: string | null;
	readonly interpolate_linear_keys: boolean | null;
	readonly externally_inverted: boolean | null;
	readonly enum_path: string | null;
	readonly keys: readonly { readonly frame: number; readonly value: T }[] | null;
}

export type LevelSequenceDiscreteChannel =
	| ({ readonly value_type: "bool" } & LevelSequenceDiscreteChannelData<boolean>)
	| ({ readonly value_type: "integer" | "byte" } & LevelSequenceDiscreteChannelData<number>);

export interface LevelSequenceNumericKey {
	readonly frame: number;
	readonly value: number;
	readonly interpolation: number;
	readonly tangent_mode: number;
	readonly tangent_weight_mode: number;
	readonly arrive_tangent: number;
	readonly leave_tangent: number;
	readonly arrive_tangent_weight: number;
	readonly leave_tangent_weight: number;
}

export interface LevelSequenceNumericChannel {
	readonly property_path: string;
	readonly enabled: boolean | null;
	readonly default_value: number | null;
	readonly pre_extrapolation: number;
	readonly post_extrapolation: number;
	readonly tick_resolution: LevelSequenceFrameRate;
	readonly show_curve: boolean;
	readonly keys: readonly LevelSequenceNumericKey[];
}

export interface LevelSequenceTrack {
	readonly object_path: string;
	readonly class_path: string;
	readonly property_path: string | null;
	readonly content:
		| "timed_text"
		| "sub_sequence"
		| "cinematic_shot"
		| "numeric"
		| "transform"
		| "discrete"
		| "value"
		| "camera_cut"
		| "structure_only";
	readonly sections: readonly LevelSequenceSection[];
}

export interface LevelSequenceBinding {
	readonly id: string;
	readonly name: string | null;
	readonly possessed_object_class: string | null;
	readonly kind: "possessable" | "spawnable" | "unknown";
	readonly parent_id: string | null;
	readonly object_template: string | null;
	readonly object_template_class: string | null;
	readonly tracks: readonly LevelSequenceTrack[];
}

export interface LevelSequenceReference {
	readonly owner_path: string;
	readonly owner_class_path: string;
	readonly property_path: string;
	readonly kind: "object" | "soft_object" | "data_table_row_handle";
	readonly target_path: string;
	readonly target_row?: string;
	readonly scope: "internal" | "external";
}

export interface LevelSequenceProjectionRecord {
	readonly schema_version: 6;
	readonly object_path: string;
	readonly movie_scene_path: string | null;
	readonly tick_resolution: LevelSequenceFrameRate | null;
	readonly display_rate: LevelSequenceFrameRate | null;
	readonly playback_range: LevelSequenceFrameRange | null;
	readonly bindings: readonly LevelSequenceBinding[];
	readonly root_tracks: readonly LevelSequenceTrack[];
	readonly references: readonly LevelSequenceReference[];
	readonly reference_coverage_gaps: readonly {
		readonly owner_path: string;
		readonly property_path: string;
		readonly reason:
			| "raw_property_value"
			| "native_object_tail"
			| "unresolved_object_reference";
	}[];
	readonly coverage_gaps: readonly {
		readonly object_path: string;
		readonly property_path: string;
		readonly reason:
			| "missing_reference"
			| "wrong_value_kind"
			| "mismatched_channel_lengths"
			| "unsupported_track_content"
			| "unsupported_section_content"
			| "missing_channel"
			| "missing_channel_mask";
	}[];
}

export interface LevelSequenceProjection {
	readonly schema_version: 1;
	readonly status: "complete" | "partial";
	readonly path: string;
	readonly sequences: readonly LevelSequenceProjectionRecord[];
	readonly diagnostics: readonly ProjectionDiagnostic[];
}

export type LevelSequenceResult = LevelSequenceProjection | ProjectionError;

export interface BlueprintPinReference {
	readonly node_object_path?: string;
	readonly pin_id: string;
}

export interface BlueprintText {
	readonly source: string;
	readonly namespace?: string;
	readonly key?: string;
}

export interface BlueprintMemberReference {
	readonly parent?: string;
	readonly name: string;
	readonly guid?: string;
}

export interface BlueprintTerminalType {
	readonly category: string;
	readonly subcategory: string;
	readonly subcategory_object?: string;
	readonly is_const: boolean;
	readonly is_weak_pointer: boolean;
	readonly is_uobject_wrapper: boolean;
}

export interface BlueprintPinType {
	readonly category: string;
	readonly subcategory: string;
	readonly subcategory_object?: string;
	readonly container_type: "none" | "array" | "set" | "map";
	readonly value_type?: BlueprintTerminalType;
	readonly is_reference: boolean;
	readonly is_weak_pointer: boolean;
	readonly member_reference: BlueprintMemberReference;
	readonly is_const: boolean;
	readonly is_uobject_wrapper: boolean;
	readonly serialize_as_single_precision_float: boolean;
}

export interface BlueprintPin {
	readonly id: string;
	readonly name: string;
	readonly friendly_name?: BlueprintText;
	readonly source_index: number;
	readonly tooltip: string;
	readonly direction: "input" | "output";
	readonly pin_type: BlueprintPinType;
	readonly default_value: string;
	readonly autogenerated_default_value: string;
	readonly default_object?: string;
	readonly default_text_value?: BlueprintText;
	readonly linked_to: readonly BlueprintPinReference[];
	readonly sub_pins: readonly BlueprintPinReference[];
	readonly parent_pin?: BlueprintPinReference;
	readonly reference_pass_through_connection?: BlueprintPinReference;
	readonly persistent_guid?: string;
	readonly flags: number;
}

export interface BlueprintNode {
	readonly object_path: string;
	readonly class_path: string;
	readonly kind: "event" | "function_call" | "variable_get" | "variable_set" | "other";
	readonly title: string;
	readonly position: { readonly x: number; readonly y: number };
	readonly guid?: string;
	readonly properties: readonly InspectionProperty[];
	readonly pins: readonly BlueprintPin[];
	readonly subclass_tail_bytes: number;
}

export interface BlueprintGraph {
	readonly object_path: string;
	readonly name: string;
	readonly guid?: string;
	readonly nodes: readonly BlueprintNode[];
	readonly links: readonly {
		readonly from: BlueprintPinReference;
		readonly to: BlueprintPinReference;
	}[];
}

export interface BlueprintGraphProjectionRecord {
	readonly schema_version: 2;
	readonly object_path: string;
	readonly graphs: readonly BlueprintGraph[];
	readonly definition: BlueprintDefinition;
	readonly coverage_gaps: readonly {
		readonly object_path: string;
		readonly reason:
			| "missing_node_reference"
			| "null_node_reference"
			| "null_pin"
			| "unresolved_pin_owner"
			| "unresolved_linked_pin"
			| "undecoded_node_property"
			| "native_node_subclass_tail"
			| "incomplete_definition";
		readonly detail: string;
	}[];
}

export interface BlueprintProjection {
	readonly schema_version: 1;
	readonly status: "ok" | "partial";
	readonly path: string;
	readonly blueprints: readonly BlueprintGraphProjectionRecord[];
	readonly diagnostics: readonly ProjectionDiagnostic[];
}

export type BlueprintResult = BlueprintProjection | ProjectionError;

export interface RuntimeLimits {
	readonly maxInputBytes: number;
	readonly maxOutputBytes: number;
	readonly maxExports: number;
	readonly maxProjectionItems: number;
}

export interface RuntimeOptions {
	readonly maxInputBytes?: number;
	readonly maxOutputBytes?: number;
}

export type BrowserWasmModule = WebAssembly.Module | ArrayBuffer | ArrayBufferView | URL;

export interface BrowserRuntimeOptions extends RuntimeOptions {
	readonly module?: BrowserWasmModule;
}

export interface WasmRuntime {
	readonly extractAnimations: (path: string, bytes: Uint8Array) => AnimationResult;
	readonly limits: RuntimeLimits;
	readonly inspect: (path: string, bytes: Uint8Array) => InspectionResult;
	readonly extractText: (path: string, bytes: Uint8Array) => TextResult;
	readonly extractTextures: (path: string, bytes: Uint8Array) => TextureResult;
	readonly extractAuthoringTable: (path: string, bytes: Uint8Array) => AuthoringTableResult;
	readonly extractLevelSequences: (path: string, bytes: Uint8Array) => LevelSequenceResult;
	readonly extractBlueprints: (path: string, bytes: Uint8Array) => BlueprintResult;
	readonly version: () => string;
}

export type AuthoringValue =
	| { readonly kind: "bool"; readonly value: boolean }
	| {
			readonly kind:
				| "int"
				| "uint"
				| "name"
				| "enum"
				| "string"
				| "text"
				| "guid"
				| "soft_object_path";
			readonly value: string;
	  }
	| {
			readonly kind: "float" | "double";
			readonly value: number | "nan" | "infinity" | "-infinity";
	  }
	| { readonly kind: "object_ref"; readonly value: string | null }
	| {
			readonly kind: "row_reference";
			readonly tableObjectPath: string | null;
			readonly rowName: string;
	  }
	| { readonly kind: "vector"; readonly x: number; readonly y: number; readonly z: number }
	| { readonly kind: "array" | "set"; readonly values: readonly AuthoringValue[] }
	| {
			readonly kind: "map";
			readonly entries: readonly {
				readonly key: AuthoringValue;
				readonly value: AuthoringValue;
			}[];
	  }
	| { readonly kind: "struct"; readonly fields: readonly AuthoringFieldValue[] }
	| { readonly kind: "unsupported"; readonly reason: string; readonly byteSize: number };

export interface AuthoringFieldValue {
	readonly name: string;
	readonly typeName: string;
	readonly value: AuthoringValue;
}

/** The portable saved-file producer emits authoring contract 2.1 with unavailable reflection. */
export interface SavedAuthoringTableSnapshot {
	readonly contract: {
		readonly name: "unreal-authoring";
		readonly version: { readonly major: 2; readonly minor: 1 };
	};
	readonly authority: { readonly kind: "project_files"; readonly packageName: string };
	readonly completeness: "complete" | "partial";
	readonly diagnostics: readonly {
		readonly code: string;
		readonly message: string;
		readonly path: string | null;
	}[];
	readonly fingerprint: { readonly status: "unavailable"; readonly reason: string };
	readonly producer: { readonly name: string; readonly version: string };
	readonly table: {
		readonly kind: "data_table" | "composite_data_table";
		readonly objectPath: string;
		readonly rowStruct: string;
		readonly parentTables: readonly string[];
		readonly packageName: string;
		readonly schema: { readonly status: "unavailable"; readonly reason: string };
		readonly rows: readonly {
			readonly id: string;
			readonly name: string;
			readonly fields: readonly AuthoringFieldValue[];
		}[];
	};
}

export type AuthoringTableResult =
	| ProjectionError
	| {
			readonly schema_version: 1;
			readonly status: "ok" | "partial";
			readonly path: string;
			readonly snapshot: SavedAuthoringTableSnapshot;
	  };

export interface AnimationSummary {
	readonly schema_version: 1;
	readonly object_path: string;
	readonly skeleton: string | null;
	readonly data_model: string | null;
	readonly data_model_class: string | null;
	readonly duration_seconds: number | null;
	readonly rate_scale: number | null;
	readonly looping: boolean | null;
	readonly frame_rate: { readonly numerator: number; readonly denominator: number } | null;
	readonly frame_count: number | null;
	readonly bone_tracks: readonly { readonly name: string; readonly property_path: string }[];
	readonly curves: readonly {
		readonly name: string;
		readonly kind: "float" | "transform";
		readonly key_count: number | null;
		readonly property_path: string;
	}[];
	readonly notifies: readonly {
		readonly name: string | null;
		readonly time_seconds: number | null;
		readonly duration_seconds: number | null;
		readonly track_index: number | null;
		readonly notify_object: string | null;
		readonly notify_state_object: string | null;
		readonly property_path: string;
	}[];
	readonly root_motion: {
		readonly enabled: boolean | null;
		readonly root_lock: string | null;
		readonly force_root_lock: boolean | null;
		readonly normalized_scale: boolean | null;
	};
	readonly coverage_gaps: readonly {
		readonly object_path: string;
		readonly property_path: string;
		readonly reason:
			| "missing_saved_property"
			| "undecoded_value"
			| "missing_export"
			| "unsupported_data_model"
			| "unsupported_track"
			| "invalid_value";
	}[];
}

export type AnimationResult =
	| ProjectionError
	| {
			readonly schema_version: 1;
			readonly status: "complete" | "partial";
			readonly path: string;
			readonly animations: readonly AnimationSummary[];
			readonly diagnostics: readonly {
				readonly object_path: string;
				readonly message: string;
			}[];
	  };

export class WasmInputLimitError extends Error {
	readonly name: "WasmInputLimitError";
	readonly code: "UE_SHED_UASSET_WASM_INPUT_LIMIT";
	readonly actualBytes: number;
	readonly maxBytes: number;
	constructor(actualBytes: number, maxBytes: number);
}

export class WasmOutputLimitError extends Error {
	readonly name: "WasmOutputLimitError";
	readonly code: "UE_SHED_UASSET_WASM_OUTPUT_LIMIT";
	readonly actualBytes: number;
	readonly maxBytes: number;
	constructor(actualBytes: number, maxBytes: number);
}

export class WasmProtocolError extends Error {
	readonly name: "WasmProtocolError";
	readonly code: "UE_SHED_UASSET_WASM_PROTOCOL";
	readonly operation: string;
	constructor(operation: string, message: string, cause?: unknown);
}

export class WasmInitializationError extends Error {
	readonly name: "WasmInitializationError";
	readonly code: "UE_SHED_UASSET_WASM_INITIALIZATION";
	constructor(message: string, cause?: unknown);
}

export interface SequenceSectionSettings {
	readonly row_index: number | null;
	readonly overlap_priority: number | null;
	readonly is_active: boolean | null;
	readonly is_locked: boolean | null;
	readonly pre_roll_frames: number | null;
	readonly post_roll_frames: number | null;
	readonly blend_type: readonly InspectionProperty[] | null;
	readonly easing: readonly InspectionProperty[] | null;
}
export interface SequenceObjectValue {
	readonly soft_path: string | null;
	readonly hard_path: string | null;
}
export type SequenceValueChannel =
	| {
			readonly value_type: "string";
			readonly property_path: string;
			readonly has_default_value: boolean | null;
			readonly default_value: string | null;
			readonly keys: readonly { readonly frame: number; readonly value: string }[] | null;
	  }
	| {
			readonly value_type: "object";
			readonly property_path: string;
			readonly property_class: string | null;
			readonly default_value: SequenceObjectValue | null;
			readonly keys:
				| readonly { readonly frame: number; readonly value: SequenceObjectValue }[]
				| null;
	  };
export interface SequenceCameraCut {
	readonly binding: {
		readonly guid: string | null;
		readonly sequence_id: number | null;
		readonly resolve_parent_index: number | null;
	} | null;
	readonly lock_previous_camera: boolean | null;
}
export interface BlueprintSavedObject {
	readonly native_data?: InspectionValue;
	readonly object_path: string;
	readonly class_path: string;
	readonly properties: readonly InspectionProperty[];
}
export interface BlueprintVariable {
	readonly name: string | null;
	readonly guid: string | null;
	readonly pin_type: BlueprintPinType | null;
	readonly category: BlueprintText | null;
	readonly property_flags: string | null;
	readonly default_value: string | null;
	readonly properties: readonly InspectionProperty[];
}
export interface BlueprintComponentNode {
	readonly object_path: string;
	readonly variable_name: string | null;
	readonly guid: string | null;
	readonly component_class: string | null;
	readonly template: BlueprintSavedObject | null;
	readonly children: readonly string[] | null;
	readonly attach_to_name: string | null;
	readonly parent_component_name: string | null;
	readonly parent_owner_class_name: string | null;
	readonly parent_is_native: boolean | null;
}
export interface BlueprintDefinition {
	readonly parent_class: string | null;
	readonly variables: readonly BlueprintVariable[] | null;
	readonly default_object: BlueprintSavedObject | null;
	readonly construction_script: {
		readonly object_path: string;
		readonly root_nodes: readonly string[] | null;
		readonly nodes: readonly BlueprintComponentNode[];
	} | null;
}
