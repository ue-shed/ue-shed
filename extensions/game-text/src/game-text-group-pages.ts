import {
	MAX_TEXT_OPEN_GROUPS,
	type TextCorpusRows,
	type TextCorpusRowsResult,
	type TextCorpusSearchRequest
} from "@ue-shed/game-text/schema";
import { Deferred, Effect, Exit } from "effect";
import type { GameTextClientApi, GameTextClientError } from "./game-text-client.js";

/** An open group's first page, or why the rows are unavailable. */
export type GroupPageResult =
	| { readonly status: "ready"; readonly page: TextCorpusRows }
	| Exclude<TextCorpusRowsResult, { readonly status: "ready" }>;

interface Batch {
	readonly signature: string;
	readonly keys: string[];
	/** The batch's answer; `undefined` when its sender stopped, so each group reads alone. */
	readonly done: Deferred.Deferred<TextCorpusRowsResult | undefined, GameTextClientError>;
	sent: boolean;
}

/**
 * Reads open groups' first pages. The groups a search opens ask in the same update, and share one
 * rows request of up to 20 groups instead of one search each. A group past that request's row
 * budget, or whose request stopped, reads alone with `openGroup`.
 */
export function groupFirstPages(client: () => Pick<GameTextClientApi, "searchRows">) {
	let open: Batch | undefined;
	const alone = (request: TextCorpusSearchRequest, key: string) =>
		client().searchRows({ ...request, openGroup: key });
	const pick = (
		request: TextCorpusSearchRequest,
		key: string,
		result: TextCorpusRowsResult | undefined
	): Effect.Effect<GroupPageResult, GameTextClientError> => {
		if (result === undefined) return alone(request, key);
		if (result.status !== "ready") return Effect.succeed(result);
		const page = result.page.openGroups?.find((group) => group.key === key)?.page;
		return page ? Effect.succeed({ status: "ready", page }) : alone(request, key);
	};
	const close = (batch: Batch) => {
		batch.sent = true;
		if (open === batch) open = undefined;
	};
	return (request: TextCorpusSearchRequest, key: string) =>
		Effect.gen(function* () {
			const signature = JSON.stringify(request);
			const joined =
				open &&
				!open.sent &&
				open.signature === signature &&
				open.keys.length < MAX_TEXT_OPEN_GROUPS
					? open
					: undefined;
			if (joined) {
				joined.keys.push(key);
				return yield* pick(request, key, yield* Deferred.await(joined.done));
			}
			const batch: Batch = {
				signature,
				keys: [key],
				done: yield* Deferred.make<TextCorpusRowsResult | undefined, GameTextClientError>(),
				sent: false
			};
			open = batch;
			const result = yield* Effect.yieldNow.pipe(
				// Groups opened in the same update join before the request is sent.
				Effect.andThen(
					Effect.suspend(() => {
						close(batch);
						return client().searchRows({
							...request,
							openGroups: batch.keys,
							firstRows: request.pageSize
						});
					})
				),
				Effect.onExit((exit) => {
					close(batch);
					return Exit.hasInterrupts(exit)
						? Deferred.succeed(batch.done, undefined)
						: Deferred.done(batch.done, exit);
				})
			);
			return yield* pick(request, key, result);
		});
}
