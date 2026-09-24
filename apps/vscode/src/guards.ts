/** The URL to hand to the OS for a frame's open-external request, or null for anything but http(s). */
export function externalUrlToOpen(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
}

const AUTH_FAILURE_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES_PER_WINDOW = 2;

/**
 * Records an auth failure reported by the web app. Each one normally triggers
 * a silent re-pair; once they come faster than re-pairing can fix, the host
 * stops and asks the user instead of looping.
 */
export function recordAuthFailure(
  recent: ReadonlyArray<number>,
  now: number,
): { readonly recent: ReadonlyArray<number>; readonly exhausted: boolean } {
  const next = [...recent.filter((at) => now - at < AUTH_FAILURE_WINDOW_MS), now];
  return { recent: next, exhausted: next.length > MAX_AUTH_FAILURES_PER_WINDOW };
}
