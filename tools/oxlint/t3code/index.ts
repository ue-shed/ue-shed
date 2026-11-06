// Rules vendored from pingdotgg/t3code's oxlint-plugin-t3code. Copyright (c) 2026 T3 Tools Inc.
// MIT License; see ./LICENSE. Keep the rule files close to upstream so they can be resynced.
import { eslintCompatPlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import preferEffectFn from "./rules/prefer-effect-fn.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

/** Effect, Schema and comment rules ported from t3code. */
const t3codePlugin = eslintCompatPlugin({
	meta: { name: "t3code" },
	rules: {
		"no-inline-schema-compile": noInlineSchemaCompile,
		"no-low-value-comments": noLowValueComments,
		"prefer-effect-fn": preferEffectFn,
		"require-suppression-reason": requireSuppressionReason
	}
});

export default t3codePlugin;
