import { Router, type Request, type Response } from "express";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Papa from "papaparse";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "../data/stocks.csv");

interface RawStock {
  Symbol: string;
  Description: string;
  Price: string;
  "Price - Currency": string;
  "Price Change % 1 day": string;
  "Volume 1 day": string;
  "Relative Volume 1 day": string;
  "Market capitalization": string;
  "Market capitalization - Currency": string;
  "Price to earnings ratio": string;
  "Earnings per share diluted, Trailing 12 months": string;
  "Earnings per share diluted, Trailing 12 months - Currency": string;
  "Earnings per share diluted growth %, TTM YoY": string;
  "Dividend yield %, Trailing 12 months": string;
  Sector: string;
  "Analyst Rating": string;
}

function ratingScore(rating: string): number {
  switch (rating.toLowerCase()) {
    case "strong buy": return 100;
    case "buy": return 75;
    case "neutral": return 40;
    case "no rating": return 50;
    default: return 50;
  }
}

function parseNum(val: string): number | null {
  if (val === "" || val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function computeStrengthScore(
  priceChange: number,
  relVol: number,
  epsGrowth: number | null,
  peRatio: number | null,
  analystRating: string
): number {
  let score = 0;

  // 1-day momentum (30 pts): higher % change → stronger
  const momentumScore = Math.min(Math.max((priceChange / 15) * 30, 0), 30);
  score += momentumScore;

  // Relative volume (20 pts): > 1 = above average activity
  const volScore = Math.min(Math.max((relVol / 2.5) * 20, 0), 20);
  score += volScore;

  // EPS growth (25 pts): positive growth is bullish
  if (epsGrowth !== null) {
    const clampedGrowth = Math.min(Math.max(epsGrowth, -100), 200);
    const growthScore = ((clampedGrowth + 100) / 300) * 25;
    score += growthScore;
  } else {
    score += 12.5; // neutral if unknown
  }

  // Analyst rating (25 pts)
  score += (ratingScore(analystRating) / 100) * 25;

  return Math.round(Math.min(Math.max(score, 0), 100));
}

function computeTrendOutlook(
  strengthScore: number,
  priceChange: number,
  relVol: number,
  epsGrowth: number | null
): string {
  let bullPoints = 0;
  let bearPoints = 0;

  if (strengthScore >= 60) bullPoints += 2;
  else if (strengthScore <= 35) bearPoints += 2;

  if (priceChange > 5) bullPoints += 2;
  else if (priceChange > 2) bullPoints += 1;
  else bearPoints += 1;

  if (relVol > 1.5) bullPoints += 1;
  else if (relVol < 0.7) bearPoints += 1;

  if (epsGrowth !== null) {
    if (epsGrowth > 20) bullPoints += 2;
    else if (epsGrowth > 0) bullPoints += 1;
    else if (epsGrowth < -50) bearPoints += 2;
    else bearPoints += 1;
  }

  if (bullPoints > bearPoints + 1) return "Bullish";
  if (bearPoints > bullPoints + 1) return "Bearish";
  return "Neutral";
}

function computeMomentumSignal(priceChange: number, relVol: number): string {
  if (relVol >= 1.5 && priceChange > 5) return "High Volume Breakout";
  if (relVol >= 1.0 && priceChange > 0) return "Accumulation";
  if (relVol >= 1.0 && priceChange < 0) return "Distribution";
  return "Low Activity";
}

function computeValuationSignal(peRatio: number | null, epsGrowth: number | null): string {
  if (peRatio === null) return "N/A";
  if (peRatio > 100) return "Overvalued";
  if (peRatio < 0) return "Negative Earnings";
  if (peRatio < 15) return "Undervalued";
  return "Fair";
}

function loadStocks(): Promise<RawStock[]> {
  return new Promise((resolve, reject) => {
    const content = fs.readFileSync(DATA_PATH, "utf-8");
    const result = Papa.parse<RawStock>(content, {
      header: true,
      skipEmptyLines: true,
    });
    if (result.errors.length > 0) {
      reject(new Error(result.errors[0].message));
    } else {
      resolve(result.data);
    }
  });
}

const router = Router();

router.get("/stocks", async (req: Request, res: Response): Promise<void> => {
  const raw = await loadStocks();

  const stocks = raw.map((r) => {
    const priceChange = parseNum(r["Price Change % 1 day"]) ?? 0;
    const relVol = parseNum(r["Relative Volume 1 day"]) ?? 1;
    const epsGrowth = parseNum(r["Earnings per share diluted growth %, TTM YoY"]);
    const peRatio = parseNum(r["Price to earnings ratio"]);
    const strengthScore = computeStrengthScore(priceChange, relVol, epsGrowth, peRatio, r["Analyst Rating"]);
    const trendOutlook = computeTrendOutlook(strengthScore, priceChange, relVol, epsGrowth);

    return {
      symbol: r.Symbol,
      description: r.Description,
      price: parseNum(r.Price) ?? 0,
      priceChange1d: priceChange,
      volume1d: parseNum(r["Volume 1 day"]) ?? 0,
      relativeVolume: relVol,
      marketCap: parseNum(r["Market capitalization"]) ?? 0,
      peRatio,
      eps: parseNum(r["Earnings per share diluted, Trailing 12 months"]),
      epsGrowth,
      dividendYield: parseNum(r["Dividend yield %, Trailing 12 months"]) ?? 0,
      sector: r.Sector,
      analystRating: r["Analyst Rating"],
      strengthScore,
      trendOutlook,
      strengthCategory:
        strengthScore >= 65 ? "Strong" : strengthScore >= 40 ? "Moderate" : "Weak",
      momentumSignal: computeMomentumSignal(priceChange, relVol),
      valuationSignal: computeValuationSignal(peRatio, epsGrowth),
    };
  });

  res.json(stocks);
});

router.get("/stocks/summary", async (req: Request, res: Response): Promise<void> => {
  const raw = await loadStocks();

  const stocks = raw.map((r) => {
    const priceChange = parseNum(r["Price Change % 1 day"]) ?? 0;
    const relVol = parseNum(r["Relative Volume 1 day"]) ?? 1;
    const epsGrowth = parseNum(r["Earnings per share diluted growth %, TTM YoY"]);
    const peRatio = parseNum(r["Price to earnings ratio"]);
    const strengthScore = computeStrengthScore(priceChange, relVol, epsGrowth, peRatio, r["Analyst Rating"]);
    const trendOutlook = computeTrendOutlook(strengthScore, priceChange, relVol, epsGrowth);
    return { strengthScore, trendOutlook, priceChange, sector: r.Sector, analystRating: r["Analyst Rating"] };
  });

  const bullish = stocks.filter((s) => s.trendOutlook === "Bullish").length;
  const bearish = stocks.filter((s) => s.trendOutlook === "Bearish").length;
  const neutral = stocks.filter((s) => s.trendOutlook === "Neutral").length;
  const avgStrength = stocks.reduce((s, x) => s + x.strengthScore, 0) / stocks.length;
  const avgChange = stocks.reduce((s, x) => s + x.priceChange, 0) / stocks.length;

  const sectorCounts: Record<string, number> = {};
  stocks.forEach((s) => { sectorCounts[s.sector] = (sectorCounts[s.sector] ?? 0) + 1; });
  const topSector = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  const strongBuy = stocks.filter((s) => s.analystRating === "Strong buy").length;
  const buy = stocks.filter((s) => s.analystRating === "Buy").length;
  const neutralRating = stocks.filter((s) => s.analystRating === "Neutral").length;
  const noRating = stocks.filter((s) => s.analystRating === "No rating").length;

  res.json({
    totalStocks: stocks.length,
    bullishCount: bullish,
    neutralCount: neutral,
    bearishCount: bearish,
    avgStrengthScore: Math.round(avgStrength * 10) / 10,
    avgPriceChange1d: Math.round(avgChange * 100) / 100,
    topSector,
    strongBuyCount: strongBuy,
    buyCount: buy,
    neutralRatingCount: neutralRating,
    noRatingCount: noRating,
  });
});

router.get("/stocks/sector-breakdown", async (req: Request, res: Response): Promise<void> => {
  const raw = await loadStocks();

  const sectorMap: Record<string, { scores: number[]; changes: number[]; top: { symbol: string; score: number } }> = {};

  raw.forEach((r) => {
    const priceChange = parseNum(r["Price Change % 1 day"]) ?? 0;
    const relVol = parseNum(r["Relative Volume 1 day"]) ?? 1;
    const epsGrowth = parseNum(r["Earnings per share diluted growth %, TTM YoY"]);
    const peRatio = parseNum(r["Price to earnings ratio"]);
    const strengthScore = computeStrengthScore(priceChange, relVol, epsGrowth, peRatio, r["Analyst Rating"]);
    const sector = r.Sector;

    if (!sectorMap[sector]) {
      sectorMap[sector] = { scores: [], changes: [], top: { symbol: r.Symbol, score: strengthScore } };
    }
    sectorMap[sector].scores.push(strengthScore);
    sectorMap[sector].changes.push(priceChange);
    if (strengthScore > sectorMap[sector].top.score) {
      sectorMap[sector].top = { symbol: r.Symbol, score: strengthScore };
    }
  });

  const result = Object.entries(sectorMap).map(([sector, data]) => ({
    sector,
    count: data.scores.length,
    avgStrengthScore: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10,
    avgPriceChange1d: Math.round((data.changes.reduce((a, b) => a + b, 0) / data.changes.length) * 100) / 100,
    strongestSymbol: data.top.symbol,
  }));

  res.json(result.sort((a, b) => b.avgStrengthScore - a.avgStrengthScore));
});

export default router;
