// Data for the interactive authoring illustration. Field order and rows mirror the
// fixture's DT_Scalars DataTable verbatim; edits never leave the browser.

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
