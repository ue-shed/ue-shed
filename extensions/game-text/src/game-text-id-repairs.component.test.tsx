import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	TextOccurrenceId,
	TextUnitId,
	TextIdRepairId,
	LocalizationSelection,
	type TextCorpusFocus,
	type TextIdRepairPlan
} from "@ue-shed/game-text/schema";
import { LocalizationFocus, type RelatedUnit } from "@ue-shed/game-text/corpus";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createSignal } from "solid-js";
import { afterAll, afterEach, expect, it } from "vitest";
import { GameTextIdRepairs } from "./game-text-id-repairs.js";
import { createGameTextEdits } from "./game-text-translation-edits.js";
import type { GameTextClientApi } from "./game-text-client.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
afterEach(cleanup);

const focus: TextCorpusFocus = {
	unit: {
		id: TextUnitId.make("lamp"),
		source: { status: "conflicting", values: ["Lamp on", "Lamp off"] },
		identity: { status: "resolved", namespace: "UI", key: "Lamp" },
		contexts: [],
		locationKinds: ["asset_property"],
		characterCount: 8,
		wordCount: 2,
		occurrenceCount: 2,
		remainingContextCount: 0,
		reviewSignals: ["conflicting"]
	},
	occurrences: ["Lamp on", "Lamp off"].map((source, index) => ({
		id: TextOccurrenceId.make(`place:${index}`),
		packageFile: `Content/Lamp${index}.uasset`,
		devNotes: "",
		source,
		identity: { status: "resolved", namespace: "UI", key: "Lamp" },
		location: {
			kind: "asset_property",
			objectPath: `/Game/Lamp${index}.Lamp${index}`,
			propertyPath: "Text",
			classPath: "/Script/Fixture.Notes"
		},
		editCapability: "read_only"
	})),
	totalOccurrences: 2,
	diagnostics: []
};

function mount(
	options: {
		readonly rejected?: boolean;
		readonly failed?: boolean;
		readonly incomplete?: boolean;
		readonly related?: readonly TextCorpusFocus[];
		/** The selection's other units under its key. */
		readonly sameKey?: readonly TextCorpusFocus[];
		readonly details?: readonly LocalizationFocus[];
		readonly withTarget?: boolean;
	} = {}
) {
	let planned: TextIdRepairPlan | undefined;
	let applied = 0;
	let checked = 0;
	let changeFocus: () => void = () => undefined;
	let editModel: ReturnType<typeof createGameTextEdits> | undefined;
	const target = options.withTarget
		? LocalizationSelection.fields.target.make("Game")
		: undefined;
	// The engine's related units: the selection, then the other keys holding its text.
	const member = (item: TextCorpusFocus): RelatedUnit => {
		const detail = options.details?.find(
			(entry) => entry.origin.kind === "corpus" && entry.origin.unitIds.includes(item.unit.id)
		);
		return {
			kind: "unit",
			unit: item.unit,
			occurrences: item.occurrences,
			totalOccurrences: item.totalOccurrences,
			complete: item.occurrences.length === item.totalOccurrences,
			...(target && detail
				? {
						line: { id: detail.id, identity: detail.identity },
						translations: detail.translations,
						translationsComplete: detail.nextCultureOffset === undefined
					}
				: undefined)
		};
	};
	const client: Pick<GameTextClientApi, "idRepairs" | "related" | "locateAsset"> = {
		related: ({ selection }) => {
			const items = options.related ?? [];
			const self = items.find((item) => item.unit.id === selection.id) ?? focus;
			return Effect.succeed({
				status: "found",
				related: {
					self: member(self),
					sameKey: { members: (options.sameKey ?? []).map(member), complete: true },
					sameText: {
						members: items.filter((item) => item.unit.id !== self.unit.id).map(member),
						complete: true
					}
				}
			});
		},
		locateAsset: () => Effect.never,
		idRepairs: {
			prepare: (request) =>
				Effect.sync(() => {
					checked++;
					planned = {
						id: TextIdRepairId.make("11111111-1111-4111-8111-111111111111"),
						request,
						sessionId: "session",
						endpoint: "http://localhost:30010",
						artifact: "Saved/UEShed/GameTextActions/proposal.json",
						preview: {
							contract: "ue-shed-game-text-actions",
							version: "1.0",
							mode: "dry_run",
							status: options.rejected ? "rejected" : "ok",
							rolledBack: false,
							actions: [],
							packages: [],
							blueprints: [],
							errors: options.rejected
								? [
										{
											code: "key_conflict",
											message: "Unreal cannot retain this key.",
											recovery: "Choose another key.",
											retrySafe: false,
											nextStep: "fix_input"
										}
									]
								: []
						}
					};
					return { status: "prepared", plan: planned };
				}),
			apply: () =>
				Effect.sync(() => {
					applied++;
					if (!planned) throw new Error("No preview");
					return {
						status: "finished",
						plan: planned,
						result: {
							...planned.preview,
							mode: "apply",
							status: options.failed ? "failed" : "ok"
						},
						verified: !options.failed
					};
				})
		}
	};
	function Panel() {
		const [current, setCurrent] = createSignal(
			options.incomplete ? { ...focus, totalOccurrences: 3 } : (options.related?.[0] ?? focus)
		);
		changeFocus = () =>
			setCurrent({ ...focus, unit: { ...focus.unit, id: TextUnitId.make("another") } });
		const edits = createGameTextEdits({
			client: {},
			target: () => target,
			nativeCulture: () => undefined,
			busy: () => false,
			onWritten: () => undefined
		});
		editModel = edits;
		return (
			<GameTextIdRepairs
				focus={current()}
				detail={options.details?.[0]}
				client={client}
				projectKey="C:/Fixture"
				target={target}
				nativeCulture={undefined}
				edits={edits}
				busy={false}
				onApplied={() => undefined}
			/>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<Panel />
		</EffectRuntimeProvider>
	));
	return {
		applied: () => applied,
		checked: () => checked,
		plan: () => planned,
		changeFocus,
		staged: () => editModel?.edits() ?? []
	};
}

function translationsFor(item: TextCorpusFocus, translation: string): LocalizationFocus {
	return Schema.decodeUnknownSync(LocalizationFocus)({
		id: `loc:${item.unit.id}`,
		origin: { kind: "corpus", unitIds: [item.unit.id] },
		identity: item.unit.identity.status === "resolved" ? item.unit.identity : null,
		source: "Lamp on",
		locations: [],
		translatorNotes: [],
		totalLocations: 1,
		totalCultures: 1,
		translations: [
			{
				culture: "de",
				state: "translated",
				facts: [],
				unknownReasons: [],
				reducedSourceChecking: false,
				gameTranslation: translation,
				gameTextKind: "translation",
				archiveTranslation: translation,
				cultureState: null,
				translationSource: "Lamp on",
				poTranslation: translation,
				translatorComments: [],
				flags: [],
				remainingComments: 0,
				remainingFlags: 0
			}
		]
	});
}

it("requires an explicit surviving key and translation, staging only after verified mutation", async () => {
	const related: TextCorpusFocus[] = ["Lamp", "AnotherLamp"].map((key, index) => {
		const identity = { status: "resolved", namespace: "UI", key } as const;
		return {
			...focus,
			unit: {
				...focus.unit,
				id: TextUnitId.make(key),
				identity,
				source: { status: "consistent", value: "Lamp on" },
				reviewSignals: []
			},
			occurrences: [{ ...focus.occurrences[index]!, source: "Lamp on", identity }],
			totalOccurrences: 1
		};
	});
	const test = mount({
		related,
		details: related.map((item, index) =>
			translationsFor(item, index === 0 ? "Lampe an" : "Licht an")
		),
		withTarget: true
	});
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Compare matching keys" }));
	const keys = await screen.findAllByRole("radio");
	expect(keys.every((key) => key instanceof HTMLInputElement && !key.checked)).toBe(true);
	await user.click(keys[0]!);
	expect(screen.getByRole("button", { name: "Preview merge" })).toHaveProperty("disabled", true);
	await user.selectOptions(
		screen.getByRole("combobox", { name: "de translation to keep" }),
		"Licht an"
	);
	await user.click(screen.getByRole("button", { name: "Preview merge" }));
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	expect(test.staged()).toHaveLength(0);
	expect(test.plan()?.request.changes[0]?.edit).toEqual({
		kind: "adopt_key",
		namespace: "UI",
		key: "Lamp",
		source: "Lamp on"
	});
	await user.click(await screen.findByRole("button", { name: "Apply and save in Unreal" }));
	await waitFor(() => expect(test.staged()).toHaveLength(1));
	expect(test.staged()[0]?.edit).toMatchObject({
		key: "Lamp",
		translation: "Licht an",
		seenTranslation: "Lampe an"
	});
});

it("moves the selection's units with the same text along with its key", async () => {
	const unit = (id: string, key: string, place: number): TextCorpusFocus => {
		const identity = { status: "resolved", namespace: "UI", key } as const;
		return {
			...focus,
			unit: {
				...focus.unit,
				id: TextUnitId.make(id),
				identity,
				source: { status: "consistent", value: "Lamp on" },
				reviewSignals: []
			},
			occurrences: [{ ...focus.occurrences[place]!, source: "Lamp on", identity }],
			totalOccurrences: 1
		};
	};
	const test = mount({
		related: [unit("Lamp", "Lamp", 0), unit("AnotherLamp", "AnotherLamp", 1)],
		sameKey: [
			unit("LampCopy", "Lamp", 1),
			{
				...unit("LampOther", "Lamp", 0),
				unit: {
					...unit("LampOther", "Lamp", 0).unit,
					source: { status: "consistent", value: "Lamp off" }
				}
			}
		]
	});
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Compare matching keys" }));
	const keys = await screen.findAllByRole("radio");
	expect(keys).toHaveLength(3);
	await user.click(keys[2]!);
	await user.click(screen.getByRole("button", { name: "Preview merge" }));
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	expect(
		new Set(
			test
				.plan()
				?.request.changes.map(
					(change) => change.edit.kind === "adopt_key" && change.edit.key
				)
		)
	).toEqual(new Set(["AnotherLamp"]));
	expect(test.plan()?.request.changes).toHaveLength(2);
});

it("waits for every culture before splitting and never stages translations after a failed apply", async () => {
	const detail = translationsFor(focus, "Lampe an");
	mount({ withTarget: true, details: [{ ...detail, totalCultures: 2, nextCultureOffset: 1 }] });
	expect(screen.getAllByRole("button", { name: "Give this text its own key" })[0]).toHaveProperty(
		"disabled",
		true
	);
	cleanup();
	const test = mount({ withTarget: true, details: [detail], failed: true });
	const user = userEvent.setup();
	await user.click(screen.getAllByRole("button", { name: "Give this text its own key" })[0]!);
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	await user.click(await screen.findByRole("button", { name: "Apply and save in Unreal" }));
	await screen.findByRole("alert");
	expect(test.staged()).toHaveLength(0);
});

it("separates picking, native preview and explicit apply, preserving a shared new key", async () => {
	const test = mount();
	const user = userEvent.setup();
	await user.click(screen.getAllByRole("button", { name: "Give this text its own key" })[1]!);
	expect(test.applied()).toBe(0);
	expect(test.checked()).toBe(0);
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	await screen.findByRole("button", { name: "Apply and save in Unreal" });
	expect(test.applied()).toBe(0);
	expect(test.plan()?.request.changes[0]).toMatchObject({
		occurrence: { source: "Lamp off" },
		edit: { kind: "change_key", namespace: "UI" }
	});
	await user.click(screen.getByRole("button", { name: "Apply and save in Unreal" }));
	await screen.findByRole("status");
	expect(test.applied()).toBe(1);
	expect(screen.getByRole("status").textContent).toContain("saved files were verified");
	expect(screen.getByRole("group", { name: "Unreal ID repair receipt" }).textContent).toContain(
		"Saved-file verification: passed"
	);
});

it("keeps native rejection visible and prevents apply", async () => {
	const test = mount({ rejected: true });
	const user = userEvent.setup();
	await user.click(screen.getAllByRole("button", { name: "Use this text everywhere" })[0]!);
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	await screen.findByRole("alert");
	expect(screen.getByRole("button", { name: "Apply and save in Unreal" })).toHaveProperty(
		"disabled",
		true
	);
	expect(test.applied()).toBe(0);
});

it("locks a failed mutation until reconciliation instead of offering replay", async () => {
	const test = mount({ failed: true });
	const user = userEvent.setup();
	await user.click(screen.getAllByRole("button", { name: "Give this text its own key" })[0]!);
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	await user.click(await screen.findByRole("button", { name: "Apply and save in Unreal" }));
	await screen.findByRole("alert");
	expect(screen.getByRole("button", { name: "Apply and save in Unreal" })).toHaveProperty(
		"disabled",
		true
	);
	expect(screen.getByRole("button", { name: "Check in Unreal" })).toHaveProperty(
		"disabled",
		true
	);
	expect(test.applied()).toBe(1);
});

it("invalidates the preview when focus changes and blocks incomplete occurrence pages", async () => {
	const test = mount();
	const user = userEvent.setup();
	await user.click(screen.getAllByRole("button", { name: "Give this text its own key" })[0]!);
	await user.click(screen.getByRole("button", { name: "Check in Unreal" }));
	await screen.findByRole("group", { name: "Unreal ID fix preview" });
	test.changeFocus();
	await waitFor(() =>
		expect(screen.queryByRole("group", { name: "Unreal ID fix preview" })).toBeNull()
	);
	cleanup();
	mount({ incomplete: true });
	const panel = screen.getByRole("region", { name: "Fix localization IDs" });
	expect(
		within(panel).getAllByRole("button", { name: "Give this text its own key" })[0]
	).toHaveProperty("disabled", true);
});
