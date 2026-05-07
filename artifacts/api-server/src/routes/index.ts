import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import scannerRouter from "./scanner";
import watchlistRouter from "./watchlist";
import telegramRouter from "./telegram";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stocksRouter);
router.use(scannerRouter);
router.use(watchlistRouter);
router.use(telegramRouter);

export default router;
