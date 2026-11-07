import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { GameTextResponseError } from "./response-parser.js";
import { parseTextCorpusSearchResult } from "./schema.js";
it.effect("parses a host result and names the result that breaks the contract", () => Effect.gen(function* () {
    expect(yield* parseTextCorpusSearchResult({ status: "not_ready" })).toEqual({
        status: "not_ready"
    });
    const error = yield* Effect.flip(
    // A host from another version sends a status this client does not know.
    parseTextCorpusSearchResult(JSON.parse('{ "status": "pending" }')));
    expect(error).toBeInstanceOf(GameTextResponseError);
    expect(error).toMatchObject({
        code: "invalid_response",
        message: "The text search result does not match the Game Text contract.",
        retrySafe: false
    });
    expect(error.cause).toBeDefined();
}));
