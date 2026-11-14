import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Schema } from "effect";

/** Holds the Unreal lane for one `release:prepare` run until `release`. */
export type LaneLease = { readonly path: string; readonly release: () => void };

/** The run a lease file names. */
export const LaneHolder = Schema.Struct({ pid: Schema.Int, startedAt: Schema.String });
export type LaneHolder = typeof LaneHolder.Type;
/** A lease file's holder; throws on a file that is not one. */
export const decodeLaneHolder = Schema.decodeUnknownSync(Schema.fromJsonString(LaneHolder));

const hasCode = (cause: unknown, code: string) =>
	cause instanceof Error && "code" in cause && cause.code === code;

/** Whether a process with this ID is running; `EPERM` means it is, owned by someone else. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return hasCode(cause, "EPERM");
	}
}

function holderOf(path: string): LaneHolder | undefined {
	try {
		return decodeLaneHolder(readFileSync(path, "utf8"));
	} catch {
		// Missing, or not a lease this script wrote: no holder.
		return undefined;
	}
}

/**
 * Leases the Unreal lane that runs from every worktree share, so another run cannot check out and
 * clean it under this run's gates. The lease sits beside the lane (`git clean -x` empties the
 * lane). Any existing lease fails this call before the lane changes, even a killed run's: its
 * builds and editors can outlive it, so only a person who has checked may delete the lease.
 */
export function acquireLaneLease(lane: string): LaneLease {
	const path = `${lane}.lock`;
	// Written in full first, then linked into place: linking fails when a lease exists, so exactly
	// one run gets it and no run ever sees a lease without its holder.
	const pending = `${path}.${process.pid}`;
	writeFileSync(
		pending,
		JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
	);
	try {
		linkSync(pending, path);
	} catch (cause) {
		if (!hasCode(cause, "EEXIST")) throw cause;
		throw new Error(busy(lane, path, holderOf(path)));
	} finally {
		rmSync(pending, { force: true });
	}
	return {
		path,
		release: () => {
			if (holderOf(path)?.pid === process.pid) rmSync(path, { force: true });
		}
	};
}

function busy(lane: string, path: string, holder: LaneHolder | undefined): string {
	const alternative = "or pass --unreal-worktree <path> to use another lane.";
	if (holder !== undefined && running(holder.pid))
		return `The Unreal lane ${lane} is in use by another release:prepare (pid ${holder.pid}, since ${holder.startedAt}). Wait for it to finish, ${alternative}`;
	const who =
		holder === undefined
			? "an unreadable lease"
			: `a release:prepare that is no longer running (pid ${holder.pid}, since ${holder.startedAt})`;
	return `The Unreal lane ${lane} is leased by ${who}. Its builds or Unreal editors may still be running in the lane. Once none are, delete ${path} and run again, ${alternative}`;
}
