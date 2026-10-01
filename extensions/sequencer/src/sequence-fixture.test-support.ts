import type { SequenceReadResult } from "./contract.js";

export const sequenceReadFixture: Extract<SequenceReadResult, { status: "ready" }> = {
	status: "ready",
	assetPath: "C:/Project/LS.uasset",
	outcome: "partial",
	diagnostics: [],
	sequence: {
		schema_version: 6,
		object_path: "/Game/LS.LS",
		movie_scene_path: "/Game/LS.LS:MovieScene",
		tick_resolution: { numerator: 24000, denominator: 1 },
		display_rate: { numerator: 24, denominator: 1 },
		playback_range: {
			lower: { kind: "inclusive", frame: 0 },
			upper: { kind: "exclusive", frame: 48000 }
		},
		bindings: [],
		root_tracks: [
			{
				object_path: "/Game/LS.LS:MovieScene.Track",
				class_path: "/Script/MovieSceneTracks.MovieSceneFloatTrack",
				content: "numeric",
				property_path: "Intensity",
				sections: [
					{
						object_path: "/Game/LS.LS:MovieScene.Track.Section",
						class_path: "/Script/MovieSceneTracks.MovieSceneFloatSection",
						range: {
							lower: { kind: "inclusive", frame: 0 },
							upper: { kind: "exclusive", frame: 48000 }
						},
						sequence_path: null,
						shot_display_name: null,
						text_keys: [],
						discrete_channels: [],
						value_channels: [],
						settings: {
							row_index: null,
							overlap_priority: null,
							is_active: null,
							is_locked: null,
							pre_roll_frames: null,
							post_roll_frames: null,
							blend_type: null,
							easing: null
						},
						camera_cut: null,
						numeric_channels: [
							{
								property_path: "FloatCurve",
								enabled: true,
								default_value: 0.5,
								tick_resolution: { numerator: 24000, denominator: 1 },
								show_curve: true,
								pre_extrapolation: 0,
								post_extrapolation: 0,
								keys: [
									{
										frame: 12000,
										value: 0.75,
										interpolation: 2,
										tangent_mode: 0,
										tangent_weight_mode: 0,
										arrive_tangent: 0.1,
										leave_tangent: 0.2,
										arrive_tangent_weight: 0,
										leave_tangent_weight: 0
									}
								]
							}
						]
					}
				]
			}
		],
		references: [
			{
				owner_path: "/Game/LS.LS",
				owner_class_path: "/Script/LevelSequence.LevelSequence",
				property_path: "Sequence",
				target_path: "/Game/Child.Child",
				scope: "external",
				kind: "soft_object"
			}
		],
		reference_coverage_gaps: [],
		coverage_gaps: [
			{
				object_path: "/Game/LS.LS",
				property_path: "OtherTrack",
				reason: "unsupported_track_content"
			}
		]
	}
};
