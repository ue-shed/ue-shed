import { Schema } from "effect";
const ProcessId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(4_294_967_295));
/**
 * Asks the editor to bring its window forward. `expectedProcessId` guards against acting on a
 * different editor than the host connected to; a mismatch returns `target_changed`.
 */
export const EditorWindowActivationRequest = Schema.Struct({ expectedProcessId: ProcessId });
/**
 * What the editor did: `activated`, or why not (`blocked` when the operating system refused focus,
 * `unavailable`, `unsupported` on platforms without the capability, `target_changed`). `target`
 * names the window that was raised, a modal dialog when one is open.
 */
export const EditorWindowActivationResult = Schema.Struct({
    schemaVersion: Schema.Literal(1),
    processId: ProcessId,
    status: Schema.Literals([
        "activated",
        "blocked",
        "unavailable",
        "unsupported",
        "target_changed"
    ]),
    target: Schema.Literals(["main_editor", "modal", "none"]),
    restored: Schema.Boolean,
    message: Schema.String,
    recovery: Schema.String
});
