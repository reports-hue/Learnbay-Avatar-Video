import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import generateRouter from "./generate.js";
import brandRouter from "./brand.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(generateRouter);
router.use(brandRouter);

export default router;
