import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import generateRouter from "./generate.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(generateRouter);

export default router;
