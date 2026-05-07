import { Router, type Request, type Response } from "express";

const router = Router();

interface WatchlistItem {
  id: string;
  symbol: string;
  addedAt: string;
  source: "manual" | "scan";
  note: string;
  confirmed: boolean;
  resonanceScore: number;
  lastPrice: number;
  alertSent: boolean;
  alertSentAt: string | null;
  // Snapshot of scan data for TG alert (stored when added)
  vcpPct: number | null;
  bigTrend: boolean;
  h2Squeezed: boolean;
  m15Trigger: boolean;
  levels: Record<string, unknown> | null;
}

interface WatchlistBatchResult {
  symbols: string[];
  total: number;
  results: Array<{
    symbol: string;
    resonanceScore: number;
    levels: Record<string, unknown>;
    vcpPct: number | null;
    bigTrend: boolean;
    h2Squeezed: boolean;
    m15Trigger: boolean;
    resonanceAchieved: boolean;
    lastPrice: number;
    scannedAt: string;
  }>;
}

// In-memory store (persists for server lifetime)
const watchlist = new Map<string, WatchlistItem>();
let watchlistCursor = 0;

// GET /watchlist
router.get("/watchlist", (_req: Request, res: Response) => {
  const items = Array.from(watchlist.values()).sort(
    (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
  );
  res.json(items);
});

// POST /watchlist — add symbol to watchlist
router.post("/watchlist", (req: Request, res: Response) => {
  const {
    symbol, note = "", resonanceScore = 0, lastPrice = 0,
    vcpPct = null, bigTrend = false, h2Squeezed = false,
    m15Trigger = false, levels = null, source = "manual",
  } = req.body ?? {};
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  const sym = String(symbol).toUpperCase();
  const id = `${sym}_${Date.now()}`;
  const item: WatchlistItem = {
    id,
    symbol: sym,
    addedAt: new Date().toISOString(),
    source: source === "scan" ? "scan" : "manual",
    note: String(note),
    confirmed: false,
    resonanceScore: Number(resonanceScore),
    lastPrice: Number(lastPrice),
    alertSent: false,
    alertSentAt: null,
    vcpPct: vcpPct !== null ? Number(vcpPct) : null,
    bigTrend: Boolean(bigTrend),
    h2Squeezed: Boolean(h2Squeezed),
    m15Trigger: Boolean(m15Trigger),
    levels: levels ?? null,
  };
  watchlist.set(id, item);
  res.status(201).json(item);
});

// PATCH /watchlist/:id — confirm or update note
router.patch("/watchlist/:id", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const item = watchlist.get(id);
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (req.body.confirmed !== undefined) item.confirmed = Boolean(req.body.confirmed);
  if (req.body.note !== undefined) item.note = String(req.body.note);
  if (req.body.alertSent !== undefined) {
    item.alertSent = Boolean(req.body.alertSent);
    item.alertSentAt = item.alertSent ? new Date().toISOString() : null;
  }
  watchlist.set(id, item);
  res.json(item);
});

// DELETE /watchlist/:id
router.delete("/watchlist/:id", (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!watchlist.has(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  watchlist.delete(id);
  res.json({ ok: true });
});

router.get("/watchlist/batch", (_req: Request, res: Response) => {
  const items = Array.from(watchlist.values()).sort(
    (a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()
  );
  const batch = items.slice(watchlistCursor, watchlistCursor + 20);
  watchlistCursor = items.length === 0 ? 0 : (watchlistCursor + 20) % items.length;
  const payload: WatchlistBatchResult = {
    symbols: batch.map((item) => item.symbol),
    total: batch.length,
    results: batch as unknown as WatchlistBatchResult["results"],
  };
  res.json(payload);
});

export default router;
