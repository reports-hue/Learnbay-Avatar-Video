import { useState, type FormEvent } from "react";
import { Clapperboard, Loader2, Lock, Mail } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface LoginProps {
  /**
   * Called after a successful POST /api/auth/login. Receives the issued token
   * AND email so the parent (AuthGate) can persist the session and flip its
   * own state in the same render tick. Passing the token directly (instead of
   * via a module-level side-channel) eliminates the ordering hazard where the
   * parent could read the token before this component had assigned it.
   */
  onLoginSuccess: (token: string, email: string) => void;
}

/**
 * Single-card branded login screen for Libraryminds Video Generator.
 *
 * Design choices:
 *  - Centered card on a soft gradient backdrop using the brand purple
 *    (`--primary: 262 80% 56%`) so it visually belongs to the existing app.
 *  - Same Clapperboard logo + "Libraryminds Video Generator" wordmark used in
 *    the sidebar (App.tsx) for instant brand continuity.
 *  - Button has a real loading state during the network request to prevent
 *    double-submits and give the user immediate feedback.
 *  - Error message is rendered in a styled callout (not a browser alert) and
 *    auto-clears when the user edits either field.
 */
export function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (!email.trim() || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.status === 401) {
        setError("Invalid email or password. Please try again.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Sign-in failed (HTTP ${res.status}).`);
        return;
      }

      const body = (await res.json()) as { token: string; email: string };
      if (!body.token || !body.email) {
        setError("Login response was incomplete. Please try again.");
        return;
      }
      // Hand off to AuthGate which will persist the session AND flip its own
      // state in the same tick (unmounting this component).
      onLoginSuccess(body.token, body.email);
    } catch (err) {
      setError("Could not reach the server. Please check your connection and try again.");
      console.error("[Login] network error", err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-primary/5">
      <div className="w-full max-w-md">
        {/* Brand wordmark above the card */}
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-lg shadow-primary/20 mb-3">
            <Clapperboard className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Libraryminds</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Video Generator</p>
        </div>

        <Card className="shadow-xl border-border/60">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>Enter your credentials to access the dashboard.</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-medium">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
                    placeholder="you@company.com"
                    className="pl-9"
                    disabled={submitting}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-medium">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
                    placeholder="••••••••"
                    className="pl-9"
                    disabled={submitting}
                    required
                  />
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2"
                >
                  {error}
                </div>
              )}

              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground mt-6">
          Authorized access only. All sign-in attempts are logged.
        </p>
      </div>
    </div>
  );
}

