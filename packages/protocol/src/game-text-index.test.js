import { Schema } from "effect";
import { expect, it } from "vitest";
import { UAssetIoRequest } from "./uasset-io.js";
import { encodeGameTextJoinInput, GameTextIndexBuildRequest } from "./game-text-index.js";
const decodeGameTextIndexBuildRequest = Schema.decodeSync(GameTextIndexBuildRequest);
const EncodedJoinInput = Schema.Struct({
    stringCodeUnits: Schema.Record(Schema.String, Schema.Array(Schema.Int))
});
const decodeIoRequest = Schema.decodeUnknownSync(UAssetIoRequest);
const decodeEncodedJoinInput = Schema.decodeUnknownSync(EncodedJoinInput);
it("negotiates native builds without changing older operation versions", () => {
    const request = {
        contract: { name: "uasset-io", version: { major: 1, minor: 13 } },
        requestId: "native",
        limits: {},
        operation: { kind: "game_text_index", request: { action: "capabilities" } }
    };
    expect(decodeIoRequest(request).operation.kind).toBe("game_text_index");
    expect(() => decodeIoRequest({
        ...request,
        contract: { name: "uasset-io", version: { major: 1, minor: 12 } }
    })).toThrow();
    expect(() => decodeGameTextIndexBuildRequest({
        action: "strings",
        configuration: {
            cacheRoot: "cache",
            projectKey: "project",
            targetKey: "target",
            sharedProject: false
        },
        ids: [-1],
        output: "response"
    })).toThrow();
});
it("encodes malformed UTF-16 values and object keys with collision-free handles", () => {
    const input = {
        target: { name: "Example" },
        review: {
            records: [{ namespace: "NS\ud800", key: "K", fingerprint: "__ue_shed_join_utf16_" }]
        },
        fileErrors: { ["Bad\udfff.po"]: "invalid_schema" }
    };
    const encoded = encodeGameTextJoinInput(JSON.stringify(input));
    expect(JSON.stringify(encoded)).not.toContain("\\ud800");
    expect(JSON.stringify(encoded)).not.toContain("\\udfff");
    const decoded = decodeEncodedJoinInput(encoded);
    expect(Object.values(decoded.stringCodeUnits)).toContainEqual([78, 83, 0xd800]);
    expect(Object.values(decoded.stringCodeUnits)).toContainEqual([
        66, 97, 100, 0xdfff, 46, 112, 111
    ]);
    expect(Object.keys(decoded.stringCodeUnits).every((key) => key.startsWith("__ue_shed_join_utf16__"))).toBe(true);
});
