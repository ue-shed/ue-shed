// Mock data for the showcase panels. The authoring rows and audit findings mirror the
// repository fixture verbatim; the review scene and observatory stream are illustrations
// of the live experience, labeled as such in the UI.

export type AuthoringFieldType = "bool" | "int" | "float" | "name" | "text";

export type AuthoringField = {
	readonly name: string;
	readonly type: AuthoringFieldType;
};

export type AuthoringRow = {
	readonly id: string;
	readonly name: string;
	readonly values: Readonly<Record<string, string | boolean>>;
};

// Field order and the first two rows come from the fixture's DT_Scalars DataTable.
export const authoringFields: readonly AuthoringField[] = [
	{ name: "Enabled", type: "bool" },
	{ name: "Count", type: "int" },
	{ name: "Ratio", type: "float" },
	{ name: "Key", type: "name" },
	{ name: "Notes", type: "text" }
];

export const authoringRows: readonly AuthoringRow[] = [
	{
		id: "row:Scalar_Alpha",
		name: "Scalar_Alpha",
		values: {
			Enabled: true,
			Count: "7",
			Ratio: "0.25",
			Key: "Alpha",
			Notes: "First deterministic scalar row."
		}
	},
	{
		id: "row:Scalar_Beta",
		name: "Scalar_Beta",
		values: {
			Enabled: false,
			Count: "42",
			Ratio: "0.75",
			Key: "Beta",
			Notes: "Base value overridden by the second composite parent."
		}
	},
	{
		id: "row:Scalar_Gamma",
		name: "Scalar_Gamma",
		values: {
			Enabled: true,
			Count: "128",
			Ratio: "1.5",
			Key: "Gamma",
			Notes: "Extra row so the grid has something to scroll."
		}
	},
	{
		id: "row:Scalar_Delta",
		name: "Scalar_Delta",
		values: {
			Enabled: true,
			Count: "1024",
			Ratio: "3.75",
			Key: "Delta",
			Notes: "Extra row so the grid has something to scroll."
		}
	},
	{
		id: "row:Scalar_Epsilon",
		name: "Scalar_Epsilon",
		values: {
			Enabled: false,
			Count: "0",
			Ratio: "0",
			Key: "Epsilon",
			Notes: "Extra row so the grid has something to scroll."
		}
	}
];

export type AuditFinding = {
	readonly ruleId: string;
	readonly severity: "warning" | "error";
	readonly objectPath: string;
	readonly explanation: string;
	readonly actual: string;
	readonly expected: string;
};

// Verbatim findings from `ue-shed audit textures` against the fixture corpus.
export const auditFindings: readonly AuditFinding[] = [
	{
		ruleId: "dimensions.power_of_two",
		severity: "warning",
		objectPath: "/Game/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180",
		explanation: "300×180 is not power-of-two on both axes.",
		actual: "Source dimensions: 300 × 180",
		expected: "Each axis is a power of two"
	},
	{
		ruleId: "dimensions.ui_max_512",
		severity: "warning",
		objectPath: "/Game/Fixture/Audits/Textures/T_Audit_UI_1024x512",
		explanation: "TEXTUREGROUP_UI texture exceeds its 512px source limit.",
		actual: "Largest axis: 1024px",
		expected: "Maximum axis: 512px"
	}
];

export const auditDimensionChips: readonly string[] = [
	"256×256 ×2",
	"512×256",
	"300×180",
	"1024×512"
];

export type ObservatoryFamily = "orbit" | "path" | "wander";

export type ObservatoryActor = {
	readonly id: string;
	readonly cls: string;
	readonly family: ObservatoryFamily;
	readonly radius: number;
	readonly speed: number;
	readonly phase: number;
	readonly seed: number;
};

// The fixture observatory map places an orbit, a ping-pong path, and a seeded wander.
export const observatoryActors: readonly ObservatoryActor[] = [
	{
		id: "Orbit_01",
		cls: "BP_OrbitActor",
		family: "orbit",
		radius: 42,
		speed: 0.9,
		phase: 0,
		seed: 0
	},
	{
		id: "Orbit_02",
		cls: "BP_OrbitActor",
		family: "orbit",
		radius: 68,
		speed: 0.6,
		phase: 2.1,
		seed: 0
	},
	{
		id: "Orbit_03",
		cls: "BP_OrbitActor",
		family: "orbit",
		radius: 94,
		speed: 0.4,
		phase: 4.2,
		seed: 0
	},
	{
		id: "Path_01",
		cls: "BP_PathActor",
		family: "path",
		radius: 0,
		speed: 0.55,
		phase: 0,
		seed: 0
	},
	{
		id: "Path_02",
		cls: "BP_PathActor",
		family: "path",
		radius: 0,
		speed: 0.34,
		phase: 0.5,
		seed: 0
	},
	{
		id: "Wander_01",
		cls: "BP_WanderActor",
		family: "wander",
		radius: 0,
		speed: 26,
		phase: 0,
		seed: 11
	},
	{
		id: "Wander_02",
		cls: "BP_WanderActor",
		family: "wander",
		radius: 0,
		speed: 34,
		phase: 0,
		seed: 29
	},
	{
		id: "Wander_03",
		cls: "BP_WanderActor",
		family: "wander",
		radius: 0,
		speed: 21,
		phase: 0,
		seed: 47
	}
];
