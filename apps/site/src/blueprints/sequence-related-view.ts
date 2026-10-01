import type { SequenceReadResult } from "@ue-shed/extension-sequencer/contract";
import { sequenceStats } from "@ue-shed/extension-sequencer/wasm";

type SequenceView =
	| {
			readonly status: "available";
			readonly read: Extract<SequenceReadResult, { readonly status: "ready" }>;
			readonly subtitle: string;
	  }
	| { readonly status: "unavailable"; readonly message: string }
	| { readonly status: "hidden" };

export function sequenceRelatedView(
	read: SequenceReadResult | undefined,
	isSequence = true
): SequenceView {
	if (read?.status === "ready") {
		const stats = sequenceStats(read.sequence);
		if (stats.tracks > 0 || stats.bindings > 0) {
			return {
				status: "available",
				read,
				subtitle: `${stats.tracks} tracks · ${stats.keys} keys`
			};
		}
	}
	if (!isSequence) return { status: "hidden" };
	return {
		status: "unavailable",
		message:
			read?.status === "failed"
				? `No timeline view: ${read.message}`
				: "No timeline view: this Level Sequence has no saved tracks or bindings to display."
	};
}
