import { Effect, Layer } from "effect";
import { AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { typeScriptIndexBuilderLayer as builder } from "./index-builder-reference.test-support.js";
import { nativeIndexQueryLayer } from "./index-query-native.js";

/**
 * The TypeScript reference builder, read through the engine: a test that runs it beside the
 * native builder compares what the two builders store, through the one reader. Never imported by
 * production.
 */
export const typeScriptIndexBuilderLayer = Layer.merge(
	builder,
	Layer.unwrap(
		Effect.flatMap(AssetReader, (reader) => reader.configuration()).pipe(
			Effect.map(nativeIndexQueryLayer),
			Effect.provide(AssetReaderLive),
			Effect.orDie
		)
	)
);
