import type {
	AuthoringCatalogResult,
	AuthoringClientApi,
	AuthoringLoadResult,
	AuthoringSessionIntent,
	AuthoringSessionListResult,
	AuthoringSessionResult,
	AuthoringSessionReviewResult,
	AuthoringSessionView
} from "./index.js";
import {
	AuthoringClient,
	decodeAuthoringCatalogResult,
	decodeAuthoringLoadResult,
	decodeAuthoringSessionIntent,
	decodeAuthoringSessionListResult,
	decodeAuthoringSessionResult,
	decodeAuthoringSessionReviewResult
} from "./index.js";

export const browserContractSurface = {
	AuthoringClient,
	decodeAuthoringCatalogResult,
	decodeAuthoringLoadResult,
	decodeAuthoringSessionIntent,
	decodeAuthoringSessionListResult,
	decodeAuthoringSessionResult,
	decodeAuthoringSessionReviewResult
};

export type BrowserAuthoringContractSurface = {
	readonly catalog: AuthoringCatalogResult;
	readonly client: AuthoringClientApi;
	readonly intent: AuthoringSessionIntent;
	readonly list: AuthoringSessionListResult;
	readonly load: AuthoringLoadResult;
	readonly result: AuthoringSessionResult;
	readonly review: AuthoringSessionReviewResult;
	readonly view: AuthoringSessionView;
};
