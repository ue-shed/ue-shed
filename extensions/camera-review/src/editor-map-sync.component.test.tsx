import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { EditorWorldOpenRequest } from "@ue-shed/protocol";
import { ReviewSetLibrary } from "./review-set-library.js";
import { EditorMapSync } from "./editor-map-sync.js";
import { LiveReviewMapPicker } from "./review-map-picker.js";
import type {
	MapReviewEditorState,
	MapReviewMapOpenResult,
	MapReviewResult
} from "./map-review-client.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());
const contract = { name: "unreal-editor-world-control", version: { major: 1, minor: 0 } } as const;
const snapshot = {
	mapPath: "/Game/Fixture/Alpha",
	dirtyWorldPackages: [],
	playSessionActive: false
};
const editor: MapReviewEditorState = {
	status: "ready",
	world: { contract, projectName: "Fixture", snapshot }
};
const review: MapReviewResult = {
	status: "ready",
	runs: [],
	reviewSet: {
		id: "beta",
		displayName: "Beta review",
		mapPath: "/Game/Fixture/Beta",
		viewCount: 0,
		views: []
	}
};
const opened: MapReviewMapOpenResult = {
	contract,
	operationId: EditorWorldOpenRequest.fields.operationId.make("open-beta"),
	targetMapPath: "/Game/Fixture/Beta",
	outcome: "opened",
	before: snapshot,
	after: { ...snapshot, mapPath: "/Game/Fixture/Beta" }
};

it("asks before changing maps and only selects the review after a confirmed successful load", async () => {
	const completion = await Effect.runPromise(Deferred.make<MapReviewMapOpenResult>());
	const open = vi.fn(() => Deferred.await(completion));
	const select = vi.fn(() => Effect.succeed(review));
	const changed = vi.fn();
	const close = vi.fn();
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ReviewSetLibrary
				canCreate={false}
				onChanged={changed}
				onClose={close}
				client={{
					editorWorld: () => Effect.succeed(editor),
					openMapInUnreal: open,
					selectReviewSet: select,
					createReviewSet: () => Effect.die("not used"),
					reviewSetLibrary: () =>
						Effect.succeed({ status: "ready", sets: [review.reviewSet] })
				}}
			/>
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Open set" }));
	expect(await screen.findByRole("dialog", { name: "Switch the map in Unreal?" })).toBeDefined();
	expect(open).not.toHaveBeenCalled();
	expect(select).not.toHaveBeenCalled();
	await user.click(screen.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByRole("dialog", { name: "Switch the map in Unreal?" })).toBeNull();
	await user.click(screen.getByRole("button", { name: "Open set" }));
	await user.click(await screen.findByRole("button", { name: "Switch map" }));
	expect(open).toHaveBeenCalledExactlyOnceWith("/Game/Fixture/Beta");
	expect(select).not.toHaveBeenCalled();
	expect(
		within(
			screen.getByRole("dialog", { name: "Switch the map in Unreal?" })
		).getByRole<HTMLButtonElement>("button", { name: "Opening…" }).disabled
	).toBe(true);
	await Effect.runPromise(Deferred.succeed(completion, opened));
	await waitFor(() => expect(changed).toHaveBeenCalledWith(review));
	expect(select).toHaveBeenCalledExactlyOnceWith({ reviewSetId: "beta" });
	expect(close).toHaveBeenCalledOnce();
});

it("keeps a refused switch visible and offers an offline-only review choice", async () => {
	const select = vi.fn(() => Effect.succeed(review));
	const open = vi.fn(() =>
		Effect.succeed({
			outcome: "failed" as const,
			message: "Unsaved map",
			recovery: "Save in Unreal first."
		})
	);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ReviewSetLibrary
				canCreate={false}
				onChanged={() => undefined}
				onClose={() => undefined}
				client={{
					editorWorld: () => Effect.succeed(editor),
					openMapInUnreal: open,
					selectReviewSet: select,
					createReviewSet: () => Effect.die("not used"),
					reviewSetLibrary: () =>
						Effect.succeed({ status: "ready", sets: [review.reviewSet] })
				}}
			/>
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Open set" }));
	await user.click(await screen.findByRole("button", { name: "Switch map" }));
	expect((await screen.findByRole("alert")).textContent).toContain("Save in Unreal first");
	expect(select).not.toHaveBeenCalled();
	await user.click(screen.getByRole("button", { name: "Browse saved review only" }));
	await waitFor(() => expect(select).toHaveBeenCalledOnce());
	expect(open).toHaveBeenCalledOnce();
});

it("shows actual editor identity and follows only on explicit request", async () => {
	const follow = vi.fn();
	const open = vi.fn(() => Effect.succeed(opened));
	const [path, setPath] = createSignal("/Game/Fixture/Beta");
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<EditorMapSync
				mapPath={path()}
				client={{ editorWorld: () => Effect.succeed(editor), openMapInUnreal: open }}
				onFollow={(path) => {
					follow(path);
					setPath(path);
				}}
				onState={() => undefined}
			/>
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await screen.findByText(/Saved map differs:/);
	expect(follow).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
	await user.click(screen.getByRole("button", { name: "Follow editor map" }));
	expect(follow).toHaveBeenCalledExactlyOnceWith("/Game/Fixture/Alpha");
	expect(screen.queryByText(/Saved map differs:/)).toBeNull();
	expect(open).not.toHaveBeenCalled();
});

it("updates the live map picker when Unreal changes maps without sending a command back", async () => {
	const [map, setMap] = createSignal("/Game/Fixture/Alpha");
	const open = vi.fn(() => Effect.succeed(opened));
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<LiveReviewMapPicker
				editorMapPath={map()}
				onOpened={() => undefined}
				client={{
					openMapInUnreal: open,
					savedWorldMaps: () =>
						Effect.succeed([
							{ label: "Alpha", mapPath: "Content/Fixture/Alpha.umap" },
							{ label: "Beta", mapPath: "Content/Fixture/Beta.umap" }
						])
				}}
			/>
		</EffectRuntimeProvider>
	));
	await waitFor(() => expect(screen.getByRole("combobox").textContent).toContain("Alpha"));
	setMap("/Game/Fixture/Beta");
	flush();
	expect(screen.getByRole("combobox").textContent).toContain("Beta");
	expect(open).not.toHaveBeenCalled();
});
