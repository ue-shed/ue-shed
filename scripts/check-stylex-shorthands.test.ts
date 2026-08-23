import assert from "node:assert/strict";
import test from "node:test";
import { droppedShorthands, findDroppedShorthands } from "./check-stylex-shorthands.ts";

test("flags a border shorthand inside stylex.create", () => {
	const source = [
		"const styles = stylex.create({",
		"\tcard: {",
		"\t\tborder: `1px solid ${tokens.colorBorder}`,",
		"\t\tpadding: 12",
		"\t}",
		"});"
	].join("\n");
	const findings = findDroppedShorthands("card.tsx", source);
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.property, "border");
	assert.equal(findings[0]?.line, 3);
});

test("flags every per-side border shorthand", () => {
	const source = [
		"const styles = stylex.create({",
		"\trail: {",
		"\t\tborderTop: `1px solid ${tokens.colorBorder}`,",
		"\t\tborderBottom: `1px solid ${tokens.colorBorder}`,",
		"\t\tborderLeft: `1px solid ${tokens.colorBorder}`,",
		"\t\tborderRight: `1px solid ${tokens.colorBorder}`",
		"\t}",
		"});"
	].join("\n");
	assert.deepEqual(
		findDroppedShorthands("rail.tsx", source).map((finding) => finding.property),
		["borderTop", "borderBottom", "borderLeft", "borderRight"]
	);
});

test("accepts the longhands that StyleX does emit", () => {
	const source = [
		"const styles = stylex.create({",
		"\tcard: {",
		"\t\tborderColor: tokens.colorBorder,",
		"\t\tborderStyle: 'solid',",
		"\t\tborderWidth: 1,",
		"\t\tborderRadius: tokens.radiusPanel,",
		"\t\tbackgroundColor: tokens.colorSurface,",
		"\t\tpadding: '8px 12px',",
		"\t\ttransition: 'opacity 120ms ease'",
		"\t}",
		"});"
	].join("\n");
	assert.deepEqual(findDroppedShorthands("card.tsx", source), []);
});

test("ignores a shorthand in an inline style prop, where it is real CSS", () => {
	const source = [
		"const styles = stylex.create({ frame: { padding: 4 } });",
		"export function Cell() {",
		"\treturn <div style={{ border: '1px solid #fff', background: 'red' }} />;",
		"}"
	].join("\n");
	assert.deepEqual(findDroppedShorthands("cell.tsx", source), []);
});

test("ignores files with no StyleX call at all", () => {
	assert.deepEqual(findDroppedShorthands("plain.ts", "const border = '1px solid red';"), []);
});

test("covers the shorthands the StyleX property-specificity resolver refuses", () => {
	assert.deepEqual([...droppedShorthands].sort(), [
		"all",
		"animation",
		"background",
		"border",
		"borderBlock",
		"borderBottom",
		"borderInline",
		"borderInlineEnd",
		"borderInlineStart",
		"borderLeft",
		"borderRight",
		"borderTop"
	]);
});
