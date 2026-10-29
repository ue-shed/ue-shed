import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonNumber, isJsonObject, parseJson, type JsonValue } from "./json.ts";

export const boatRunner = "boat-large";
export const githubRunner = "ubuntu-24.04";
/**
 * Starts left free for runs that read the same remaining count before this run's jobs start, so
 * two runs that begin together cannot both take the last starts and then wait for the window.
 */
export const startHeadroom = 6;

export interface BoatStarts {
	readonly unlimited: boolean;
	readonly day: number;
	readonly hour: number;
}

/** The remaining starts in a boat `GET /limits` response; undefined when it reports none. */
export function remainingStarts(body: JsonValue): BoatStarts | undefined {
	if (!isJsonObject(body)) return undefined;
	if (body.canStart === false) return { unlimited: false, day: 0, hour: 0 };
	const starts = body.starts;
	if (!isJsonObject(starts)) return undefined;
	if (starts.unlimited === true) return { unlimited: true, day: 0, hour: 0 };
	const remaining = (window: JsonValue | undefined) =>
		window !== undefined && isJsonObject(window) && isJsonNumber(window.remaining)
			? window.remaining
			: undefined;
	const day = remaining(starts.day);
	const hour = remaining(starts.hour);
	return day === undefined || hour === undefined ? undefined : { unlimited: false, day, hour };
}

/**
 * The runner for the lanes that run on boat. Every boat job is one start, and a start over the
 * plan's limit waits for the window to clear, so the lanes use boat only when boat confirms the
 * run's starts fit with headroom. Without that answer they use GitHub-hosted runners.
 */
export function selectRunner(needed: number, starts: BoatStarts | undefined) {
	if (!starts) return githubRunner;
	if (starts.unlimited) return boatRunner;
	const required = needed + startHeadroom;
	return starts.day >= required && starts.hour >= required ? boatRunner : githubRunner;
}

async function fetchStarts(key: string, org: string) {
	const headers = new Headers({ authorization: `Bearer ${key}` });
	if (org !== "") headers.set("x-boat-org", org);
	try {
		const response = await fetch("https://boat.dev/api/v1/limits", {
			headers,
			signal: AbortSignal.timeout(15_000)
		});
		if (!response.ok) {
			console.log(`boat's limits API answered ${response.status}.`);
			return undefined;
		}
		return remainingStarts(parseJson(await response.text()));
	} catch (error) {
		console.log(`boat's limits API failed: ${String(error)}`);
		return undefined;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const needed =
		1 +
		Number(process.env.UASSET_LIBRARIES === "true") +
		Number(process.env.UASSET_IO === "true");
	const key = process.env.BOAT_API_KEY ?? "";
	// Pull requests from forks get no secrets, so they always use GitHub-hosted runners.
	if (key === "") console.log("No BOAT_API_KEY: using GitHub-hosted runners.");
	const starts = key === "" ? undefined : await fetchStarts(key, process.env.BOAT_ORG ?? "");
	if (starts && !starts.unlimited) {
		console.log(`boat starts left: ${starts.day} today, ${starts.hour} this hour.`);
	}
	const runner = selectRunner(needed, starts);
	console.log(`This run needs ${needed} boat starts; using ${runner}.`);
	if (!process.env.GITHUB_OUTPUT)
		throw new Error("GITHUB_OUTPUT is required to publish the runner.");
	appendFileSync(process.env.GITHUB_OUTPUT, `heavy_runner=${runner}\n`);
}
