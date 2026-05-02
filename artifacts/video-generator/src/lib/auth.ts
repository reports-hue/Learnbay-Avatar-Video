/**
 * Client-side auth helpers for the Libraryminds Video Generator.
 *
 * Design notes:
 *  - Token is stored in localStorage under LM_AUTH_KEY. Sent as
 *    `Authorization: Bearer <token>` on every /api/* request via a global
 *    fetch interceptor (installed once at module load). This keeps the
 *    existing pages — which all use plain `fetch("/api/...")` — fully
 *    untouched while still being authenticated.
 *  - On any 401 from /api/* we clear the token and broadcast an
 *    `lm-auth-expired` event so the AuthGate can drop back to the Login
 *    screen mid-session (e.g., after server-side password rotation).
 *  - We never include the Authorization header on /api/auth/login itself
 *    (it's the credential exchange) and never on cross-origin URLs.
 */

const LM_AUTH_KEY = "lm_auth_token";
const LM_AUTH_EMAIL_KEY = "lm_auth_email";
const AUTH_EXPIRED_EVENT = "lm-auth-expired";

export function getToken(): string | null {
  try {
    return localStorage.getItem(LM_AUTH_KEY);
  } catch {
    return null;
  }
}

export function getEmail(): string | null {
  try {
    return localStorage.getItem(LM_AUTH_EMAIL_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string, email: string): void {
  try {
    localStorage.setItem(LM_AUTH_KEY, token);
    localStorage.setItem(LM_AUTH_EMAIL_KEY, email);
  } catch {
    /* localStorage unavailable — ignore */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(LM_AUTH_KEY);
    localStorage.removeItem(LM_AUTH_EMAIL_KEY);
  } catch {
    /* ignore */
  }
}

export function onAuthExpired(handler: () => void): () => void {
  window.addEventListener(AUTH_EXPIRED_EVENT, handler);
  return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
}

/**
 * Extract the URL string from any of the shapes the global `fetch` accepts.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Returns true if this URL is one of OUR /api/* endpoints (relative path or
 * same-origin absolute). Cross-origin URLs are never decorated with our token.
 */
function isOurApi(rawUrl: string): boolean {
  try {
    if (rawUrl.startsWith("/api/")) return true;
    const u = new URL(rawUrl, window.location.origin);
    return u.origin === window.location.origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isAuthEndpoint(rawUrl: string): boolean {
  try {
    if (rawUrl.startsWith("/api/auth/")) return true;
    const u = new URL(rawUrl, window.location.origin);
    return u.pathname.startsWith("/api/auth/");
  } catch {
    return false;
  }
}

/**
 * Install ONE-TIME global fetch interceptor that:
 *   1. Adds `Authorization: Bearer <token>` to every /api/* request (except
 *      /api/auth/* — those are the credential exchange itself).
 *   2. On 401 response from /api/* (excluding /api/auth/login which legitimately
 *      401s on bad credentials), clears the token and broadcasts an
 *      `lm-auth-expired` event so the UI can return to login.
 *
 * Idempotent: safe to call multiple times (HMR, StrictMode double-mount).
 */
let installed = false;
export function installFetchAuth(): void {
  if (installed) return;
  installed = true;

  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const ours = isOurApi(url);

    let nextInit = init;
    if (ours && !isAuthEndpoint(url)) {
      const token = getToken();
      if (token) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        nextInit = { ...(init ?? {}), headers };
      }
    }

    const res = await orig(input, nextInit);

    // Auto-logout on session expiry / password rotation. We exempt the login
    // endpoint itself (where 401 just means "wrong password, try again").
    if (res.status === 401 && ours && !isAuthEndpoint(url)) {
      clearSession();
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    }

    return res;
  };
}
