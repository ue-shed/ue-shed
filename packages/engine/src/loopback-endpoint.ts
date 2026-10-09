const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True only for an endpoint on this machine. Foreground grants and leases name local processes and
 * local windows, so a remote editor must never receive one.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
	try {
		return loopbackHosts.has(new URL(endpoint).hostname);
	} catch {
		return false;
	}
}
