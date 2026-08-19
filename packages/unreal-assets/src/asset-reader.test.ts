import { it as effectIt } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
	AssetReaderError,
	ProtocolOutputBudget,
	ProtocolStreamValidator,
	discoverSavedAssets,
	makeAssetReaderTestLayer,
	protocolCacheOutcome,
	readSavedWorld,
	type SavedWorld
} from "./index.js";
import { validateProtocolEvent } from "./protocol-transport.js";
import { ProtocolLineDecoder } from "./protocol-transport.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

effectIt.effect("routes saved-asset discovery through the AssetReader service", () =>
	Effect.gen(function* () {
		const requestedRoots = yield* Ref.make<readonly string[]>([]);
		const layer = makeAssetReaderTestLayer({
			catalogProgress: () => unexpected("catalogProgress"),
			discoverAssets: Effect.fn("AssetReader.Test.discoverAssets")(function* (
				projectRoot: string
			) {
				yield* Ref.update(requestedRoots, (roots) => [...roots, projectRoot]);
				return [`${projectRoot}/Content/DT_Test.uasset`];
			}),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readTable: () => unexpected("readTable"),
			source: () => Effect.succeed("configured")
		});

		const assets = yield* discoverSavedAssets("C:/Fixture").pipe(Effect.provide(layer));
		expect(assets).toEqual(["C:/Fixture/Content/DT_Test.uasset"]);
		expect(yield* Ref.get(requestedRoots)).toEqual(["C:/Fixture"]);
	})
);

effectIt.effect("preserves typed discovery failures from a test layer", () =>
	Effect.gen(function* () {
		const failure = new AssetReaderError({
			kind: "discovery",
			message: "Content is unavailable",
			operation: "discovery",
			path: "C:/Fixture/Content",
			retrySafe: true
		});
		const layer = makeAssetReaderTestLayer({
			catalogProgress: () => unexpected("catalogProgress"),
			discoverAssets: () => Effect.fail(failure),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readTable: () => unexpected("readTable"),
			source: () => Effect.succeed("configured")
		});

		const error = yield* discoverSavedAssets("C:/Fixture").pipe(
			Effect.flip,
			Effect.provide(layer)
		);
		expect(error).toBe(failure);
	})
);

effectIt.effect("routes a map-targeted saved-world read through the AssetReader service", () =>
	Effect.gen(function* () {
		const requestedMaps = yield* Ref.make<readonly string[]>([]);
		const savedWorld: SavedWorld = {
			authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Example" },
			completeness: "complete",
			contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
			diagnostics: [],
			externalActorRoot: "C:/Fixture/Content/__ExternalActors__/Maps/L_Example",
			mapPath: "C:/Fixture/Content/Maps/L_Example.umap",
			sourceKind: "world_partition",
			actors: [],
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 0,
				scannedPackages: 0
			}
		};
		const layer = makeAssetReaderTestLayer({
			catalogProgress: () => unexpected("catalogProgress"),
			discoverAssets: () => unexpected("discoverAssets"),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readSavedWorld: Effect.fn("AssetReader.Test.readSavedWorld")(function* (options) {
				yield* Ref.update(requestedMaps, (maps) => [...maps, options.mapPath]);
				return savedWorld;
			}),
			readTable: () => unexpected("readTable"),
			source: () => Effect.succeed("configured")
		});

		const world = yield* readSavedWorld({
			mapPath: "Content/Maps/L_Example.umap",
			projectRoot: "C:/Fixture"
		}).pipe(Effect.provide(layer));
		expect(world).toBe(savedWorld);
		expect(yield* Ref.get(requestedMaps)).toEqual(["Content/Maps/L_Example.umap"]);
	})
);

const protocolContract = {
	name: "uasset-io",
	version: { major: 1, minor: 0 }
} as const;

type TestProtocolContract = {
	readonly name: "uasset-io";
	readonly version: { readonly major: 1; readonly minor: number };
};

function acceptedEvent(sequence = 0, contract: TestProtocolContract = protocolContract) {
	return {
		contract,
		kind: "accepted" as const,
		operation: "inspect" as const,
		requestId: "protocol-test",
		sequence
	};
}

function completedEvent(sequence = 1, contract: TestProtocolContract = protocolContract) {
	return {
		contract,
		kind: "completed" as const,
		outcome: "complete" as const,
		requestId: "protocol-test",
		sequence
	};
}

describe("AssetReader protocol boundary validation", () => {
	it("frames chunked NDJSON without retaining one growing concatenated string", () => {
		const decoder = new ProtocolLineDecoder();
		expect(decoder.push('{"kind":"res')).toEqual([]);
		expect(decoder.push('ult"}\n{"kind":"completed"}\r\n')).toEqual([
			'{"kind":"result"}',
			'{"kind":"completed"}'
		]);
		expect(() => decoder.finish()).not.toThrow();

		const incomplete = new ProtocolLineDecoder();
		incomplete.push("{}");
		expect(() => incomplete.finish()).toThrow("incomplete JSON line");
	});

	it("uses a cumulative byte budget for chunks and partial lines", () => {
		const budget = new ProtocolOutputBudget(5);
		budget.observe("{}\n");
		budget.observe("{");
		expect(budget.bytes).toBe(4);
		expect(() => budget.observe("123")).toThrow("Protocol output exceeded 5 bytes");
		expect(budget.bytes).toBe(4);
	});

	it("reports cache misses only when a cache was requested", () => {
		expect(protocolCacheOutcome(false, 0, 5)).toBe("not_requested");
		expect(protocolCacheOutcome(true, 0, 0)).toBe("miss");
		expect(protocolCacheOutcome(true, 2, 0)).toBe("hit");
	});

	it("requires the request contract, one accepted first, and contiguous sequence", () => {
		const validator = new ProtocolStreamValidator(protocolContract, "protocol-test");
		validator.push(acceptedEvent());
		validator.push(completedEvent());
		validator.finish();

		expect(() =>
			new ProtocolStreamValidator(protocolContract, "protocol-test").push(completedEvent(0))
		).toThrow("must begin with an accepted");
		expect(() => {
			const duplicate = new ProtocolStreamValidator(protocolContract, "protocol-test");
			duplicate.push(acceptedEvent());
			duplicate.push(acceptedEvent(1));
		}).toThrow("more than one accepted");
		expect(() => {
			const skipped = new ProtocolStreamValidator(protocolContract, "protocol-test");
			skipped.push(acceptedEvent());
			skipped.push(completedEvent(2));
		}).toThrow("sequence expected 1");
		expect(() => {
			const mismatched = new ProtocolStreamValidator(protocolContract, "protocol-test");
			mismatched.push(
				acceptedEvent(0, { ...protocolContract, version: { major: 1, minor: 1 } })
			);
		}).toThrow("does not match the request contract");
	});

	it("rejects blank frames and frames after terminal", () => {
		const blank = new ProtocolStreamValidator(protocolContract, "protocol-test");
		expect(() => blank.pushLine(" ")).toThrow("empty frame");

		const afterTerminal = new ProtocolStreamValidator(protocolContract, "protocol-test");
		afterTerminal.pushLine(JSON.stringify(acceptedEvent()));
		afterTerminal.pushLine(JSON.stringify(completedEvent()));
		expect(() => afterTerminal.pushLine(JSON.stringify(acceptedEvent(2)))).toThrow(
			"after its terminal event"
		);
	});

	it("retains exact schema validation on the large-frame type-side path", () => {
		const malformedJson = new ProtocolStreamValidator(protocolContract, "protocol-test");
		expect(() => malformedJson.pushLine("{")).toThrow("Invalid protocol event");

		const unknownField = new ProtocolStreamValidator(protocolContract, "protocol-test");
		expect(() =>
			unknownField.pushLine(JSON.stringify({ ...acceptedEvent(), unexpected: true }))
		).toThrow("Invalid protocol event");

		const invalidNestedContract = new ProtocolStreamValidator(
			protocolContract,
			"protocol-test"
		);
		expect(() =>
			invalidNestedContract.pushLine(
				JSON.stringify({
					...acceptedEvent(),
					contract: { name: "uasset-io", version: { major: -1, minor: 0 } }
				})
			)
		).toThrow("Invalid protocol event");
	});

	it("validates small and large frames through their measured paths", () => {
		const event = acceptedEvent();
		expect(validateProtocolEvent(event, 1)).toEqual(event);
		expect(validateProtocolEvent(event, Number.MAX_SAFE_INTEGER)).toEqual(event);

		const unknown = { ...event, unexpected: true };
		expect(() => validateProtocolEvent(unknown, 1)).toThrow();
		expect(() => validateProtocolEvent(unknown, Number.MAX_SAFE_INTEGER)).toThrow();
	});
});
