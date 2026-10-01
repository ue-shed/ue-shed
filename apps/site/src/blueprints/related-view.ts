import type { BlueprintGraphReadResult } from "@ue-shed/extension-blueprint-graphs/contract";
import type { AuthoringReadResult } from "@ue-shed/extension-data-authoring/wasm";

type BlueprintView =
	| {
			readonly status: "available";
			readonly read: Extract<BlueprintGraphReadResult, { readonly status: "ready" }>;
			readonly subtitle: string;
	  }
	| { readonly status: "unavailable"; readonly message: string }
	| { readonly status: "hidden" };

/** A ready snapshot represents exactly one table, including valid empty tables. */
export function authoringRelatedView(read: AuthoringReadResult | undefined) {
	if (read?.status !== "ready") return { status: "hidden" as const };
	const fields = new Set(
		read.snapshot.table.rows.flatMap((row) => row.fields.map((field) => field.name))
	);
	const schema = "producer" in read.snapshot ? read.snapshot.table.schema : undefined;
	const fieldCount = schema?.status === "available" ? schema.fields.length : fields.size;
	return {
		status: "available" as const,
		read,
		subtitle: `${read.snapshot.table.rows.length} rows · ${fieldCount} fields`
	};
}

/** Only validated, ready Blueprint evidence with at least one saved graph is navigable. */
export function blueprintRelatedView(
	read: BlueprintGraphReadResult | undefined,
	isBlueprint = true
): BlueprintView {
	if (read?.status === "ready") {
		if (read.blueprint.graphs.length === 0) {
			return {
				status: "unavailable",
				message: "No graph view: this Blueprint has no saved editor graphs to display."
			};
		}
		const graphs = read.blueprint.graphs.length;
		const nodes = read.blueprint.graphs.reduce((count, graph) => count + graph.nodes.length, 0);
		return {
			status: "available",
			read,
			subtitle: `${graphs} graph${graphs === 1 ? "" : "s"} · ${nodes} node${nodes === 1 ? "" : "s"}`
		};
	}
	if (!isBlueprint && !(read?.status === "failed" && read.reason === "control_rig")) {
		return { status: "hidden" };
	}
	if (read?.status === "failed") {
		switch (read.reason) {
			case "control_rig":
				return {
					status: "unavailable",
					message:
						"No graph view: Control Rig Blueprints use RigVM, which isn't supported yet."
				};
			case "unsupported_asset":
				return {
					status: "unavailable",
					message: "No graph view: this Blueprint's saved graphs aren't supported yet."
				};
			default:
				return {
					status: "unavailable",
					message: `No graph view: ${read.message}`
				};
		}
	}
	return {
		status: "unavailable",
		message: "No graph view: saved Blueprint evidence is unavailable."
	};
}
