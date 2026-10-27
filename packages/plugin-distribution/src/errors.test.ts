import type { ErrorGuidanceFields, ErrorNextStep } from "@ue-shed/protocol/errors";
import { expectTypeOf, it } from "vitest";
import { PluginErrorGuidanceFields, PluginErrorNextStep } from "./errors.js";

it("keeps the independent error guidance identical to protocol", () => {
	expectTypeOf<typeof PluginErrorGuidanceFields>().toEqualTypeOf<typeof ErrorGuidanceFields>();
	expectTypeOf<typeof PluginErrorNextStep>().toEqualTypeOf<typeof ErrorNextStep>();
});
