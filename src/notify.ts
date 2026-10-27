import type { SyncFailure } from "./engine";

/**
 * Which failures haven't been announced yet. Files are tracked by direction and path,
 * not error text (GitHub request ids make every message different). Files no longer
 * failing are dropped from `notified`, so a later failure is announced again.
 */
export function unannounced(notified: Set<string>, failed: SyncFailure[]): { fresh: SyncFailure[]; notified: Set<string> } {
	const key = (f: SyncFailure) => `${f.direction}:${f.path}`;
	const current = new Set(failed.map(key));
	const fresh = failed.filter((f) => !notified.has(key(f)));
	return { fresh, notified: new Set([...notified].filter((k) => current.has(k)).concat(fresh.map(key))) };
}
