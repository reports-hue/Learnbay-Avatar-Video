import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  installFetchAuth,
  getToken,
  setSession,
  clearSession,
  onAuthExpired,
} from "@/lib/auth";
import { Login } from "@/components/Login";

type AuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; email: string };

interface AuthGateProps {
  children: ReactNode;
}

/**
 * AuthGate — wraps the entire app. Three render branches:
 *
 *   "checking"        → small centered spinner while we validate the token
 *                       on app load via GET /api/auth/me.
 *   "anonymous"       → render <Login />. On successful login, AuthGate flips
 *                       state to authenticated and unmounts Login.
 *   "authenticated"   → render children (the existing dashboard) UNTOUCHED.
 *
 * Side effects on mount (in order):
 *   1. Install the global fetch auth interceptor so every /api/* call from
 *      existing code carries the Bearer token automatically.
 *   2. If a token exists in localStorage, call /api/auth/me to confirm it's
 *      still valid (handles server restarts, password rotation, expiry).
 *   3. Subscribe to the `lm-auth-expired` window event (dispatched by the
 *      fetch interceptor on 401) so we drop back to login mid-session if the
 *      server invalidates us.
 */
export function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<AuthState>({ status: "checking" });

  useEffect(() => {
    installFetchAuth();

    let cancelled = false;

    async function bootstrap() {
      const token = getToken();
      if (!token) {
        if (!cancelled) setState({ status: "anonymous" });
        return;
      }

      try {
        const res = await fetch("/api/auth/me");
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { email: string };
          setState({ status: "authenticated", email: body.email });
        } else {
          // Token rejected by server — clear and show login.
          clearSession();
          setState({ status: "anonymous" });
        }
      } catch {
        if (cancelled) return;
        // Network error during bootstrap — treat as anonymous so user can retry.
        clearSession();
        setState({ status: "anonymous" });
      }
    }

    bootstrap();

    const offExpired = onAuthExpired(() => {
      // Server told us our token is no longer valid (e.g., password rotated).
      setState({ status: "anonymous" });
    });

    return () => {
      cancelled = true;
      offExpired();
    };
  }, []);

  if (state.status === "checking") {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (state.status === "anonymous") {
    return (
      <Login
        onLoginSuccess={(token, email) => {
          setSession(token, email);
          setState({ status: "authenticated", email });
        }}
      />
    );
  }

  // status === "authenticated" — render the real app, untouched.
  return <>{children}</>;
}
