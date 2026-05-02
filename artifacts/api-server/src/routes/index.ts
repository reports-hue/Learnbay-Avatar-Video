import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import generateRouter from "./generate.js";
import brandRouter from "./brand.js";
import voicesRouter from "./voices.js";
import authRouter from "./auth.js";

const router: IRouter = Router();

// Auth endpoints (login / me / logout) — must be public, mounted first.
router.use(authRouter);

router.use(healthRouter);
router.use(generateRouter);
router.use(brandRouter);
router.use(voicesRouter);

export default router;
