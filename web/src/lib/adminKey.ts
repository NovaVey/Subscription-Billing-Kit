// The admin key (Phase 10) is a shared secret the operator types in once per
// browser tab - sessionStorage (not localStorage) so it clears when the tab
// closes rather than persisting indefinitely on a shared machine.
//
// Trade-off, not an oversight: sessionStorage is readable by any JS running
// on this page (unlike an httpOnly cookie), so an XSS bug anywhere in this
// bundle - including a compromised dependency - could exfiltrate it. That
// risk is accepted here in exchange for a bearer header that isn't
// auto-attached like a cookie (no CSRF exposure) and no server-side session
// state to build for a kit whose spec never asked for full accounts (see
// docs/DECISIONS.md D-033). Revisit with an httpOnly cookie if this ever
// needs to withstand an actual XSS incident, not just a well-behaved client.
const STORAGE_KEY = 'admin_key';

export function getAdminKey(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setAdminKey(key: string): void {
  sessionStorage.setItem(STORAGE_KEY, key);
}

export function clearAdminKey(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
