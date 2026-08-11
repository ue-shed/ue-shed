import type { ConfigComparison, ConfigExplanation } from "@ue-shed/config-explorer/browser";

/** Host-neutral component input; it carries no acquisition or filesystem authority. */
export type ConfigExplorerSuppliedResult = ConfigExplanation | ConfigComparison;
