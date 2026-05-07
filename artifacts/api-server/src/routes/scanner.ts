import { Router, type Request, type Response } from "express";
import axios from "axios";
import cron from "node-cron";

const router = Router();

const ALPACA_BASE = "https://data.alpaca.markets/v2";
const ALPACA_PAPER = "https://paper-api.alpaca.markets/v2";
const ALPACA_KEY = process.env.ALPACA_API_KEY ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? "";

const alpacaHeaders = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
};

// SP500 + NASDAQ100 representative symbols (top liquidity)
const SP500_SYMBOLS = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","JPM","LLY",
  "V","UNH","XOM","MA","JNJ","PG","HD","COST","ABBV","MRK",
  "BAC","CVX","NFLX","WMT","AMD","ORCL","ADBE","CRM","TMO","LIN",
  "ACN","MCD","DHR","CSCO","ABT","PEP","INTC","IBM","QCOM","TXN",
  "INTU","UNP","GS","MS","BLK","SPGI","SYK","MDT","ISRG","REGN",
  "PLD","AMGN","BMY","CI","SCHW","NOW","AXP","CB","SO","DUK",
  "NEE","MO","GILD","ZTS","MMC","PNC","C","USB","EOG","SLB",
  "GE","RTX","HON","CAT","DE","BA","LMT","NOC","GD","MMM"
];

const NASDAQ100_EXTRA = [
  "PANW","CRWD","SNPS","KLAC","MRVL","ASML","CDNS","AMAT","LRCX","MCHP",
  "FTNT","WDAY","MNST","PAYX","FAST","ODFL","CTAS","EXC","XEL","FANG",
  "CEG","DXCM","IDXX","ILMN","MTCH","NXPI","ON","PCAR","ROST","SGEN",
  "SPLK","TEAM","TMUS","VRSK","VRSN","WBA","ZS","ANSS","BIIB","BKNG"
];

const ALL_SYMBOLS = [...new Set([...SP500_SYMBOLS, ...NASDAQ100_EXTRA])];

interface TimeframeResult {
  close: number;
  vcpPct: number | null;
  // UT Bot fields (monthly / weekly / daily / m15)
  utBotAbove?: boolean;    // price is above ATR trailing stop (trend up)
  utBotBuy?: boolean;      // fresh crossover above trailing stop (entry signal)
  utBotTs?: number;        // trailing stop value
  // Legacy EMA200 / TSI kept for reference
  ema200ok: boolean;
  tsiOk: boolean;
}

interface ScanResult {
  symbol: string;
  resonanceScore: number;
  levels: {
    monthly: TimeframeResult;
    weekly: TimeframeResult;
    daily: TimeframeResult;
    h2: TimeframeResult;
    m15: TimeframeResult;
  };
  bigTrend: boolean;
  h2Squeezed: boolean;
  m15Trigger: boolean;
  resonanceAchieved: boolean;
  vcpPct: number | null;
  lastPrice: number;
  scannedAt: string;
}

// In-memory cache: symbol -> result, expires after 10 min
const cache = new Map<string, { data: ScanResult; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let emaPrev = values[0];
  result.push(emaPrev);
  for (let i = 1; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    result.push(emaPrev);
  }
  return result;
}

function tsi(closes: number[], fast = 13, slow = 25): number {
  if (closes.length < slow + fast + 5) return 0;
  const momentum: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    momentum.push(closes[i] - closes[i - 1]);
  }
  const absMomentum = momentum.map(Math.abs);
  const smoothed1 = ema(momentum, slow);
  const smoothedAbs1 = ema(absMomentum, slow);
  const smoothed2 = ema(smoothed1, fast);
  const smoothedAbs2 = ema(smoothedAbs1, fast);
  const last = smoothed2[smoothed2.length - 1];
  const lastAbs = smoothedAbs2[smoothedAbs2.length - 1];
  return lastAbs === 0 ? 0 : (last / lastAbs) * 100;
}

function vcpRange(highs: number[], lows: number[], period = 20): number {
  const slice = highs.slice(-period);
  const sliceLow = lows.slice(-period);
  const maxH = Math.max(...slice);
  const minL = Math.min(...sliceLow);
  return minL === 0 ? 999 : ((maxH - minL) / minL) * 100;
}

// ATR — EMA-smoothed true range (matches pandas_ta ATR default)
function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 10
): number[] {
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // EMA-smooth the TR series (same as pandas_ta EWM with adjust=False)
  return ema(tr, period);
}

// UT Bot — ATR trailing stop + buy signal (port of the Python version)
// key=1.0, atr_period=10
// Returns:
//   aboveStop  — price is currently above the trailing stop (trend confirmation)
//   buy        — price just crossed ABOVE the trailing stop (fresh buy signal)
//   trailingStop — current trailing stop value
function utBot(
  closes: number[],
  highs: number[],
  lows: number[],
  key = 1.0,
  atrPeriod = 10
): { buy: boolean; aboveStop: boolean; trailingStop: number } {
  const n = closes.length;
  if (n < atrPeriod + 5) return { buy: false, aboveStop: false, trailingStop: 0 };

  const atrVals = atr(highs, lows, closes, atrPeriod);
  const nLoss   = atrVals.map((v) => key * v);

  // Iterative trailing stop — each bar depends on the previous bar
  const ts = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prevTs  = ts[i - 1];
    const src     = closes[i];
    const prevSrc = closes[i - 1];
    const loss    = nLoss[i];

    if (src > prevTs && prevSrc > prevTs) {
      ts[i] = Math.max(prevTs, src - loss);
    } else if (src < prevTs && prevSrc < prevTs) {
      ts[i] = Math.min(prevTs, src + loss);
    } else if (src > prevTs) {
      ts[i] = src - loss;
    } else {
      ts[i] = src + loss;
    }
  }

  const last    = n - 1;
  const currSrc = closes[last];
  const prevSrc = closes[last - 1];
  const currTs  = ts[last];
  const prevTs  = ts[last - 1];

  // aboveStop: price is currently above the trailing stop (trend is up)
  const aboveStop = currSrc > currTs;

  // buy (crossover): price just crossed above the stop on this bar
  const buy = currSrc > currTs && prevSrc <= prevTs;

  return { buy, aboveStop, trailingStop: currTs };
}

async function fetchBarsAlpaca(
  symbol: string,
  timeframe: string,
  limit: number
): Promise<{ close: number[]; high: number[]; low: number[] } | null> {
  try {
    const url = `${ALPACA_BASE}/stocks/${symbol}/bars`;
    const resp = await axios.get(url, {
      headers: alpacaHeaders,
      params: { timeframe, limit, adjustment: "all", feed: "iex" },
      timeout: 8000,
    });
    const bars = resp.data?.bars ?? [];
    return {
      close: bars.map((b: { c: number }) => b.c),
      high: bars.map((b: { h: number }) => b.h),
      low: bars.map((b: { l: number }) => b.l),
    };
  } catch {
    return null;
  }
}

async function fetchBarsYahoo(
  symbol: string,
  interval: string,
  range: string
): Promise<{ close: number[]; high: number[]; low: number[] } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
    const resp = await axios.get(url, {
      params: { interval, range, includePrePost: false },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    const result = resp.data?.chart?.result?.[0];
    if (!result) return null;
    const quotes = result.indicators?.quote?.[0];
    const closes: number[] = (quotes?.close ?? []).map((v: number | null) => v ?? 0);
    const highs: number[] = (quotes?.high ?? []).map((v: number | null) => v ?? 0);
    const lows: number[] = (quotes?.low ?? []).map((v: number | null) => v ?? 0);
    return { close: closes.filter(Boolean), high: highs.filter(Boolean), low: lows.filter(Boolean) };
  } catch {
    return null;
  }
}

// Alpaca timeframe -> Yahoo interval/range mapping
const tfMap: Record<string, { alpaca: string; limit: number; yahooInterval: string; yahooRange: string }> = {
  monthly: { alpaca: "1Month", limit: 250, yahooInterval: "1mo", yahooRange: "20y" },
  weekly:  { alpaca: "1Week",  limit: 250, yahooInterval: "1wk", yahooRange: "5y" },
  daily:   { alpaca: "1Day",   limit: 250, yahooInterval: "1d",  yahooRange: "1y" },
  h2:      { alpaca: "2Hour",  limit: 250, yahooInterval: "1h",  yahooRange: "60d" },
  m15:     { alpaca: "15Min",  limit: 200, yahooInterval: "15m", yahooRange: "7d" },
};

async function getTimeframeData(
  symbol: string,
  tf: keyof typeof tfMap
): Promise<{ close: number[]; high: number[]; low: number[] } | null> {
  const cfg = tfMap[tf];
  // Try Alpaca first
  let data = ALPACA_KEY ? await fetchBarsAlpaca(symbol, cfg.alpaca, cfg.limit) : null;
  // Fallback to Yahoo Finance
  if (!data || data.close.length < 30) {
    data = await fetchBarsYahoo(symbol, cfg.yahooInterval, cfg.yahooRange);
  }
  return data;
}

async function analyzeSymbol(symbol: string): Promise<ScanResult | null> {
  // Check cache
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const tfNames = ["monthly", "weekly", "daily", "h2", "m15"] as const;
  const rawData: Record<string, { close: number[]; high: number[]; low: number[] } | null> = {};

  // Fetch all timeframes in parallel
  await Promise.all(
    tfNames.map(async (tf) => {
      rawData[tf] = await getTimeframeData(symbol, tf);
    })
  );

  // Need at least monthly/weekly/daily data
  if (!rawData.monthly || !rawData.weekly || !rawData.daily) return null;

  const levels: Record<string, TimeframeResult> = {};

  for (const tf of tfNames) {
    const d = rawData[tf];
    if (!d || d.close.length < 30) {
      levels[tf] = { ema200ok: false, tsiOk: false, vcpPct: null, close: 0 };
      continue;
    }
    const closes = d.close;
    const highs  = d.high;
    const lows   = d.low;
    const lastClose = closes[closes.length - 1];

    // EMA 200 (use available length up to 200)
    const emaPeriod = Math.min(200, closes.length - 1);
    const emaVals   = ema(closes, emaPeriod);
    const ema200ok  = lastClose > emaVals[emaVals.length - 1];

    // TSI (Vista) — fast=13, slow=25
    const tsiVal = tsi(closes, 13, 25);
    const tsiOk  = tsiVal > 0;

    // VCP range % over last 20 bars
    const vcpPct = highs.length >= 20 ? vcpRange(highs, lows, 20) : null;

    if (tf === "h2") {
      // ---- 2H: VCP contraction only (entry reserve filter) ----
      levels[tf] = { ema200ok, tsiOk, vcpPct, close: lastClose };
    } else {
      // ---- Monthly / Weekly / Daily / 15m: UT Bot ----
      // Longer TFs (monthly/weekly/daily): aboveStop = trend confirmation
      // 15m: buy crossover = fresh entry signal
      const { buy: utBotBuy, aboveStop: utBotAbove, trailingStop: utBotTs } =
        utBot(closes, highs, lows, 1.0, 10);
      levels[tf] = { ema200ok, tsiOk, vcpPct, close: lastClose, utBotAbove, utBotBuy, utBotTs };
    }
  }

  // Monthly / Weekly / Daily pass when price is ABOVE the UT Bot trailing stop
  const bigTrend =
    levels.monthly.utBotAbove === true &&
    levels.weekly.utBotAbove  === true &&
    levels.daily.utBotAbove   === true;

  // 2H: VCP contraction < 5% → entry reserve zone
  const h2Squeezed = levels.h2.vcpPct !== null && levels.h2.vcpPct < 5.0;

  // 15m: UT Bot crossover → actual buy trigger
  const m15Trigger = levels.m15.utBotBuy === true;

  const resonanceAchieved = bigTrend && h2Squeezed && m15Trigger;

  // 0-5 resonance score
  let resonanceScore = 0;
  if (levels.monthly.utBotAbove === true) resonanceScore++;
  if (levels.weekly.utBotAbove  === true) resonanceScore++;
  if (levels.daily.utBotAbove   === true) resonanceScore++;
  if (h2Squeezed)  resonanceScore++;
  if (m15Trigger)  resonanceScore++;

  const result: ScanResult = {
    symbol,
    resonanceScore,
    levels: {
      monthly: levels.monthly,
      weekly: levels.weekly,
      daily: levels.daily,
      h2: levels.h2,
      m15: levels.m15,
    },
    bigTrend,
    h2Squeezed,
    m15Trigger,
    resonanceAchieved,
    vcpPct: levels.h2.vcpPct,
    lastPrice: levels.daily.close,
    scannedAt: new Date().toISOString(),
  };

  cache.set(symbol, { data: result, ts: Date.now() });
  return result;
}

// ---- Auto-scan scheduler state ----

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   ?? "";

async function tgSend(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch { /* silent */ }
}

// ---- Market hours (US ET) ----
type MarketSession = "pre-market" | "regular" | "after-hours" | "closed" | "weekend";

interface MarketStatus {
  session: MarketSession;
  label: string;           // display label (Chinese)
  etTime: string;          // current ET time string
  nextOpenEt: string | null; // ISO of next regular open
  isTrading: boolean;      // true during pre/regular/after
}

function getEtParts(now = new Date()): { dayOfWeek: number; hour: number; minute: number; etIso: string } {
  // Use Intl to convert to America/New_York (auto-handles DST)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", minute: "numeric", hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[get("weekday")] ?? now.getUTCDay();
  const hour   = Number(get("hour"))   || 0;   // 0-23
  const minute = Number(get("minute")) || 0;

  const etIso = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "America/New_York",
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);

  return { dayOfWeek, hour, minute, etIso };
}

function getMarketStatus(now = new Date()): MarketStatus {
  const { dayOfWeek, hour, minute, etIso } = getEtParts(now);
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const totalMin = hour * 60 + minute;
  const PRE_START   = 4  * 60;        //  4:00 AM
  const REG_START   = 9  * 60 + 30;   //  9:30 AM
  const REG_END     = 16 * 60;        //  4:00 PM
  const AFTER_END   = 20 * 60;        //  8:00 PM

  let session: MarketSession;
  let label: string;

  if (isWeekend) {
    session = "weekend";
    label   = "週末休市";
  } else if (totalMin < PRE_START || totalMin >= AFTER_END) {
    session = "closed";
    label   = "深夜休市";
  } else if (totalMin < REG_START) {
    session = "pre-market";
    label   = "盤前交易";
  } else if (totalMin < REG_END) {
    session = "regular";
    label   = "正式交易中";
  } else {
    session = "after-hours";
    label   = "盤後交易";
  }

  // Compute next regular market open (9:30 AM ET next weekday)
  let nextOpenEt: string | null = null;
  if (session !== "regular") {
    const next = new Date(now);
    // If before market open today and it's a weekday, open is today
    if (!isWeekend && totalMin < REG_START) {
      next.setMinutes(next.getMinutes() + (REG_START - totalMin));
    } else {
      // Find next weekday
      let daysAhead = 1;
      while (true) {
        const candidate = (dayOfWeek + daysAhead) % 7;
        if (candidate !== 0 && candidate !== 6) break;
        daysAhead++;
      }
      next.setDate(next.getDate() + daysAhead);
      // Set to 9:30 AM ET — approximate by adjusting UTC
      const etOffset = getEtOffsetHours(next);
      next.setUTCHours(9 - etOffset, 30, 0, 0);
    }
    nextOpenEt = next.toISOString();
  }

  return {
    session,
    label,
    etTime: etIso,
    nextOpenEt,
    isTrading: session === "pre-market" || session === "regular" || session === "after-hours",
  };
}

// Returns ET UTC offset in hours (e.g. -5 for EST, -4 for EDT)
function getEtOffsetHours(date: Date): number {
  const utc = date.getTime();
  const etStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", hour12: false,
  }).format(date);
  const localHour = Number(etStr) || 0;
  return localHour - date.getUTCHours();
}

interface AutoScanState {
  enabled: boolean;
  intervalMinutes: number;
  minScoreAlert: number;
  isRunning: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResults: ScanResult[];
  lastAlerted: string[];
  totalScanned: number;
  runCount: number;
  skippedCount: number;        // times skipped due to market closed
  preMarketRanToday: boolean;  // prevent duplicate pre-market scans
  cronTask: ReturnType<typeof cron.schedule> | null;
  preMarketCron: ReturnType<typeof cron.schedule> | null;
}

const autoState: AutoScanState = {
  enabled: false,
  intervalMinutes: 30,
  minScoreAlert: 4,
  isRunning: false,
  lastRunAt: null,
  nextRunAt: null,
  lastResults: [],
  lastAlerted: [],
  totalScanned: 0,
  runCount: 0,
  skippedCount: 0,
  preMarketRanToday: false,
  cronTask: null,
  preMarketCron: null,
};

// Batch ALL_SYMBOLS into groups of 15 to avoid hammering APIs
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function runAutoScan(force = false): Promise<void> {
  if (autoState.isRunning) return;

  // Skip when market is completely closed (unless forced by user)
  if (!force) {
    const ms = getMarketStatus();
    if (!ms.isTrading) {
      autoState.skippedCount++;
      return;
    }
  }

  autoState.isRunning = true;
  autoState.runCount++;

  const batches = chunkArray(ALL_SYMBOLS, 15);
  const allResults: ScanResult[] = [];

  for (const batch of batches) {
    // Invalidate cache so we get fresh data on each auto run
    batch.forEach((s) => cache.delete(s));
    const results = await Promise.all(batch.map(analyzeSymbol));
    allResults.push(...(results.filter(Boolean) as ScanResult[]));
    // Small delay between batches to be API-friendly
    await new Promise((r) => setTimeout(r, 800));
  }

  allResults.sort((a, b) => b.resonanceScore - a.resonanceScore);
  autoState.lastResults = allResults;
  autoState.totalScanned = allResults.length;
  autoState.lastRunAt = new Date().toISOString();

  // Compute next run time
  const next = new Date(Date.now() + autoState.intervalMinutes * 60 * 1000);
  autoState.nextRunAt = next.toISOString();

  // Filter stocks that meet alert threshold
  const toAlert = allResults.filter((r) => r.resonanceScore >= autoState.minScoreAlert);
  autoState.lastAlerted = toAlert.map((r) => r.symbol);

  // Helper: format distance % from UT Bot trailing stop
  const fmtDist = (close: number, ts: number | undefined): string => {
    if (!ts || ts <= 0) return "";
    const pct = ((close - ts) / ts) * 100;
    const sign = pct >= 0 ? "+" : "";
    const tag  = pct < 0 ? "↓" : pct <= 3 ? "🎯" : "↑";
    return `${tag}${sign}${pct.toFixed(1)}%`;
  };

  if (toAlert.length === 0) {
    await tgSend(
      `🔍 <b>五級共振自動掃描完成</b>\n` +
      `📊 掃描 ${allResults.length} 支，無符合條件（≥${autoState.minScoreAlert}分）\n` +
      `📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}\n` +
      `⏰ 下次掃描：${next.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`
    );
  } else {
    // Sort by daily distance ascending (tightest setup first)
    const sorted = [...toAlert].sort((a, b) => {
      const da = a.levels.daily, db = b.levels.daily;
      const pA = da.utBotTs && da.utBotTs > 0 ? (da.close - da.utBotTs) / da.utBotTs * 100 : 9999;
      const pB = db.utBotTs && db.utBotTs > 0 ? (db.close - db.utBotTs) / db.utBotTs * 100 : 9999;
      if (a.resonanceScore !== b.resonanceScore) return b.resonanceScore - a.resonanceScore;
      return pA - pB;
    });

    const lines = sorted.slice(0, 10).map((r) => {
      const icon  = r.resonanceScore === 5 ? "🔥" : r.resonanceAchieved ? "✅" : "⭐";
      const mDist = fmtDist(r.levels.monthly.close, r.levels.monthly.utBotTs);
      const wDist = fmtDist(r.levels.weekly.close,  r.levels.weekly.utBotTs);
      const dDist = fmtDist(r.levels.daily.close,   r.levels.daily.utBotTs);
      const distParts = [mDist && `月${mDist}`, wDist && `週${wDist}`, dDist && `日${dDist}`]
        .filter(Boolean).join(" ");
      const vcpStr = r.vcpPct !== null ? `  2H ${r.vcpPct.toFixed(1)}%` : "";
      const m15Str = r.m15Trigger ? "  🚀15m金叉" : "";
      return (
        `${icon} <b>${r.symbol}</b> ${r.resonanceScore}/5  $${r.lastPrice.toFixed(2)}\n` +
        `     📏 ${distParts}${vcpStr}${m15Str}`
      );
    });

    await tgSend(
      `🚨 <b>五級共振自動掃描提示</b>\n` +
      `📊 掃描 ${allResults.length} 支，發現 ${toAlert.length} 支達標（≥${autoState.minScoreAlert}分）\n\n` +
      lines.join("\n") +
      (toAlert.length > 10 ? `\n\n  ...另有 ${toAlert.length - 10} 支` : "") +
      `\n\n⚠️ 請人工確認後再行動\n` +
      `📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}\n` +
      `⏰ 下次掃描：${next.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`
    );
  }

  autoState.isRunning = false;
}

function buildCronExpr(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    return `0 */${minutes / 60} * * *`;
  }
  return `*/${minutes} * * * *`;
}

function startCron(): void {
  // Stop existing tasks
  autoState.cronTask?.stop();
  autoState.preMarketCron?.stop();
  autoState.cronTask = null;
  autoState.preMarketCron = null;

  // Regular interval scan (skips closed hours automatically)
  const expr = buildCronExpr(autoState.intervalMinutes);
  autoState.cronTask = cron.schedule(expr, () => { void runAutoScan(false); });

  // Pre-market dedicated scan: 9:15 AM ET, Mon-Fri
  // EDT = UTC-4 → 13:15 UTC; EST = UTC-5 → 14:15 UTC
  // We check ET time at cron fire and run if it's 9:00-9:29 AM ET
  autoState.preMarketCron = cron.schedule("15 13,14 * * 1-5", () => {
    const { hour, minute } = getEtParts();
    const totalMin = hour * 60 + minute;
    const PRE_SCAN_START = 9 * 60 + 10;
    const PRE_SCAN_END   = 9 * 60 + 29;
    if (totalMin >= PRE_SCAN_START && totalMin <= PRE_SCAN_END && !autoState.preMarketRanToday) {
      autoState.preMarketRanToday = true;
      void tgSend(`🌅 <b>盤前掃描啟動</b>\n美股 09:30 開盤前15分鐘，正在掃描五級共振標的...\n📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`);
      void runAutoScan(true);  // force=true, always run at pre-market
    }
  });

  // Reset preMarketRanToday at midnight ET each weekday
  cron.schedule("0 4 * * 1-5", () => {
    autoState.preMarketRanToday = false;
  });

  autoState.enabled = true;
  autoState.nextRunAt = new Date(
    Date.now() + autoState.intervalMinutes * 60 * 1000
  ).toISOString();
}

function stopCron(): void {
  autoState.cronTask?.stop();
  autoState.preMarketCron?.stop();
  autoState.cronTask = null;
  autoState.preMarketCron = null;
  autoState.enabled = false;
  autoState.nextRunAt = null;
}

// ---- Auto-scan API routes ----

// GET /scanner/auto-status
router.get("/scanner/auto-status", (_req: Request, res: Response) => {
  const { cronTask: _cronTask, preMarketCron: _pmc, ...safeState } = autoState;
  res.json({ ...safeState, market: getMarketStatus() });
});

// POST /scanner/auto-start
router.post("/scanner/auto-start", (req: Request, res: Response) => {
  const { intervalMinutes, minScoreAlert } = req.body ?? {};
  if (intervalMinutes) autoState.intervalMinutes = Math.max(5, Math.min(240, Number(intervalMinutes)));
  if (minScoreAlert)   autoState.minScoreAlert   = Math.max(1, Math.min(5,   Number(minScoreAlert)));
  startCron();
  const ms = getMarketStatus();
  tgSend(
    `✅ <b>五級共振自動掃描已啟動</b>\n` +
    `⏱ 間隔：每 ${autoState.intervalMinutes} 分鐘（交易時段）\n` +
    `🌅 盤前：09:15 ET 自動觸發\n` +
    `🎯 提示門檻：≥ ${autoState.minScoreAlert} 分\n` +
    `📊 監控 ${ALL_SYMBOLS.length} 支股票\n` +
    `🕐 現在 ET 時間：${ms.etTime}（${ms.label}）\n` +
    `📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`
  );
  const { cronTask: _ct, preMarketCron: _pmc, ...safeState } = autoState;
  res.json({ ok: true, ...safeState, market: ms });
});

// POST /scanner/auto-stop
router.post("/scanner/auto-stop", (_req: Request, res: Response) => {
  stopCron();
  tgSend(`⏹ <b>五級共振自動掃描已停止</b>\n📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`);
  const { cronTask: _ct, preMarketCron: _pmc, ...safeState } = autoState;
  res.json({ ok: true, ...safeState, market: getMarketStatus() });
});

// POST /scanner/auto-run-now — force scan regardless of market hours
router.post("/scanner/auto-run-now", async (_req: Request, res: Response) => {
  if (autoState.isRunning) {
    res.json({ ok: false, message: "掃描進行中，請稍候" });
    return;
  }
  res.json({ ok: true, message: "已觸發立即掃描，結果將推送至 Telegram" });
  void runAutoScan(true); // force=true bypasses market-hours check
});

// GET /scanner/market — get current market status only
router.get("/scanner/market", (_req: Request, res: Response) => {
  res.json(getMarketStatus());
});

// PATCH /scanner/auto-config — update interval/threshold without restart
router.patch("/scanner/auto-config", (req: Request, res: Response) => {
  const { intervalMinutes, minScoreAlert } = req.body ?? {};
  if (intervalMinutes) autoState.intervalMinutes = Math.max(5, Math.min(240, Number(intervalMinutes)));
  if (minScoreAlert)   autoState.minScoreAlert   = Math.max(1, Math.min(5,   Number(minScoreAlert)));
  if (autoState.enabled) startCron();
  const { cronTask: _ct, preMarketCron: _pmc, ...safeState } = autoState;
  res.json({ ...safeState, market: getMarketStatus() });
});

// ---- Existing manual scan routes ----

// GET /scanner/symbols — get the full symbol list
router.get("/scanner/symbols", (_req: Request, res: Response) => {
  res.json({ symbols: ALL_SYMBOLS, total: ALL_SYMBOLS.length });
});

// GET /scanner/scan?symbols=AAPL,MSFT — scan specific symbols (max 20 at once)
router.get("/scanner/scan", async (req: Request, res: Response) => {
  const rawSymbols = (req.query.symbols as string) ?? "";
  const symbols = rawSymbols
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    res.status(400).json({ error: "Provide symbols query param, e.g. ?symbols=AAPL,MSFT" });
    return;
  }

  const results = await Promise.all(symbols.map(analyzeSymbol));
  const valid = results.filter(Boolean) as ScanResult[];
  valid.sort((a, b) => b.resonanceScore - a.resonanceScore);
  res.json(valid);
});

// GET /scanner/resonance — return only resonance-achieved stocks from a batch
router.get("/scanner/resonance", async (req: Request, res: Response) => {
  const rawSymbols = (req.query.symbols as string) ?? SP500_SYMBOLS.slice(0, 30).join(",");
  const symbols = rawSymbols
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);

  const results = await Promise.all(symbols.map(analyzeSymbol));
  const resonant = (results.filter(Boolean) as ScanResult[]).filter((r) => r.resonanceScore >= 3);
  resonant.sort((a, b) => b.resonanceScore - a.resonanceScore);
  res.json(resonant);
});

// POST /scanner/watchlist-scan — scan manual watchlist symbols in batches
router.post("/scanner/watchlist-scan", async (req: Request, res: Response) => {
  const rawSymbols = String(req.body?.symbols ?? "");
  const symbols = rawSymbols
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    res.status(400).json({ error: "symbols is required" });
    return;
  }

  const results = await Promise.all(symbols.map(analyzeSymbol));
  const valid = results.filter(Boolean) as ScanResult[];
  valid.sort((a, b) => b.resonanceScore - a.resonanceScore);
  res.json({
    symbols,
    total: symbols.length,
    results: valid,
  });
});

export default router;
