import { describe, expect, it } from "vitest";
import { diffField, filterEntries, groupByFile, type TextDiffEntry } from "./text-diff-model.js";

const marked = (segments: readonly { text: string; op: string }[]) =>
	segments
		.map((segment) => (segment.op === "same" ? segment.text : `[${segment.text}]`))
		.join("");

describe("a text diff", () => {
	it("marks the words that changed, keeping a space between two changed words in the change", () => {
		const diff = diffField("Quit to the menu", "Quit to the main menu");
		expect(marked(diff.before)).toBe("Quit to the menu");
		expect(marked(diff.after)).toBe("Quit to the [main ]menu");
		const replaced = diffField("a big red box", "a small blue box");
		expect(marked(replaced.before)).toBe("a [big red] box");
		expect(marked(replaced.after)).toBe("a [small blue] box");
	});

	it("splits text without spaces into words", () => {
		const diff = diffField("ゲームを終了する", "ゲームを保存する");
		expect(marked(diff.after)).not.toBe("[ゲームを保存する]");
		expect(diff.after.some((segment) => segment.op === "same")).toBe(true);
	});

	it("keeps format arguments and line breaks as they are", () => {
		const diff = diffField("Hello {Name}\nWelcome", "Hello {Name}\nWelcome back");
		expect(marked(diff.after)).toBe("Hello {Name}\nWelcome[ back]");
	});

	it("shows one side whole when the other is empty", () => {
		expect(marked(diffField("", "New").after)).toBe("[New]");
		expect(diffField("", "New").before).toEqual([]);
	});

	const entry = (id: string, file: string, source: string): TextDiffEntry => ({
		id,
		kind: "added",
		after: { label: `UI,${id}`, full: `UI,${id}` },
		file,
		fields: [{ label: "Source", after: source }]
	});

	it("filters by text, key or file, and groups by file in order", () => {
		const entries = [
			entry("Play", "Content/A.uasset", "Play"),
			entry("Quit", "Content/B.uasset", "Quit"),
			entry("Save", "Content/A.uasset", "Save game")
		];
		expect(filterEntries(entries, "game").map((each) => each.id)).toEqual(["Save"]);
		expect(filterEntries(entries, "ui,quit").map((each) => each.id)).toEqual(["Quit"]);
		expect(groupByFile(entries).map((group) => [group.file, group.entries.length])).toEqual([
			["Content/A.uasset", 2],
			["Content/B.uasset", 1]
		]);
	});
});
