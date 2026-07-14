import {
	decodeTextureAuditRunResult,
	type TextureAuditRunResult
} from "@ue-shed/asset-audits/browser";
import type { TextureAuditClient } from "@ue-shed/extension-asset-audits";

function decodeResult(value: unknown): TextureAuditRunResult {
	try {
		return decodeTextureAuditRunResult(value);
	} catch (cause) {
		return {
			status: "failed",
			error: {
				code: "contract_failure",
				message: `Workbench received an invalid texture audit result: ${String(cause)}`,
				recovery: "Restart Workbench. If the problem persists, verify package versions.",
				retrySafe: true
			}
		};
	}
}

export const assetAuditsClient: TextureAuditClient = {
	loadConfiguredProject: async () =>
		decodeResult(await window.ueShed.assetAudits.loadConfiguredProject()),
	chooseProjectAndScan: async () =>
		decodeResult(await window.ueShed.assetAudits.chooseProjectAndScan())
};
