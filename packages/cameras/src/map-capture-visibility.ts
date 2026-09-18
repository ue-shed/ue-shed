import { CameraAuthoredVisibility } from "./camera-visibility.js";
import { MapCapturePlan } from "./map-tile-schema.js";

/** Each returned plan remains an ordinary CLI-compatible immutable map capture input. */
export function mapCaptureVisibilityVariants(
	plan: MapCapturePlan,
	policy: CameraAuthoredVisibility
): readonly { variant: "pure" | "authored"; plan: MapCapturePlan }[] {
	const validated = MapCapturePlan.make(plan);
	const authored = CameraAuthoredVisibility.make(policy);
	if (
		authored.output === "natural_and_authored" &&
		validated.capture.render.exposureEV100 === undefined
	)
		throw new Error(
			"Paired map capture requires an explicit exposureEV100 shared by both plans."
		);
	const { visibility: _prior, ...capture } = validated.capture;
	const pure = { variant: "pure" as const, plan: MapCapturePlan.make({ ...validated, capture }) };
	const altered = {
		variant: "authored" as const,
		plan: MapCapturePlan.make({
			...validated,
			contract: { name: "ue-shed-map-capture-plan", version: { major: 1, minor: 2 } },
			capture: { ...capture, visibility: authored.actors }
		})
	};
	return authored.output === "natural_only"
		? [pure]
		: authored.output === "authored_only"
			? [altered]
			: [pure, altered];
}
