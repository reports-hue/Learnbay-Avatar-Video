import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger.js";
import { issueToken, verifyToken, constantTimeEquals } from "../lib/authToken.js";

const router: IRouter = Router();

/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 * Validates against process.env.LOGIN_EMAIL / LOGIN_PASSWORD using constant-time
 * comparison. On success returns a 7-day HMAC-signed session token.
 *
 * NEVER log the password or token contents. Logs only outcomes (ok / fail) so
 * an operator can audit access without leaking credentials. Email is logged on
 * success only (it matches the configured LOGIN_EMAIL by definition).
 */
router.post("/auth/login", (req: Request, res: Response) => {
  const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const expectedEmail = process.env.LOGIN_EMAIL;
  const expectedPassword = process.env.LOGIN_PASSWORD;
  if (!expectedEmail || !expectedPassword) {
    logger.error("LOGIN_EMAIL or LOGIN_PASSWORD env var is missing — auth disabled");
    return res.status(500).json({ error: "Auth not configured on the server" });
  }

  // Always check both fields (constant-time on each) so timing doesn't reveal
  // which field was wrong.
  const emailOk = constantTimeEquals(email.trim().toLowerCase(), expectedEmail.trim().toLowerCase());
  const passwordOk = constantTimeEquals(password, expectedPassword);

  if (!emailOk || !passwordOk) {
    logger.warn({ outcome: "login_fail" }, "Login attempt rejected");
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = issueToken(expectedEmail);
  logger.info({ outcome: "login_ok", email: expectedEmail }, "Login successful");
  return res.json({ token, email: expectedEmail });
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 * Returns { email } if the token is valid, 401 otherwise. Used by the frontend
 * AuthGate on app load to decide whether to show Login or the dashboard.
 */
router.get("/auth/me", (req: Request, res: Response) => {
  const token = extractBearer(req);
  const result = verifyToken(token);
  if (!result.ok) {
    return res.status(401).json({ error: "Unauthorized", reason: result.reason });
  }
  return res.json({ email: result.email });
});

/**
 * POST /api/auth/logout
 * Stateless — the client just discards its token. We respond 200 so the
 * frontend can confirm the logout flow ran.
 */
router.post("/auth/logout", (_req: Request, res: Response) => {
  return res.json({ ok: true });
});

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/**
 * Express middleware that enforces a valid Bearer token on every protected
 * /api/* route. Public exceptions (skipped through to next()):
 *   - /auth/*    : login / me / logout themselves
 *   - /healthz   : public liveness probe
 *
 * Mounted on `/api` in app.ts BEFORE the main router, so any route added in
 * the future is automatically protected by default. To add a new public path,
 * extend PUBLIC_PATHS below.
 */
const PUBLIC_PATHS = new Set(["/healthz"]);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // req.path here is relative to the mount point ("/api"), so e.g. a request
  // to /api/auth/login arrives with req.path === "/auth/login".
  if (req.path.startsWith("/auth/") || PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  const token = extractBearer(req);
  const result = verifyToken(token);
  if (!result.ok) {
    res.status(401).json({ error: "Unauthorized", reason: result.reason });
    return;
  }
  next();
}

export default router;
