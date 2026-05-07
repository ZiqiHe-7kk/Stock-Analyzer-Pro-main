import { Router, type Request, type Response } from "express";
import axios from "axios";

const router = Router();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

async function sendTelegram(message: string): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
    return true;
  } catch (err) {
    return false;
  }
}

// POST /telegram/send — send arbitrary message
router.post("/telegram/send", async (req: Request, res: Response) => {
  const { message } = req.body ?? {};
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const ok = await sendTelegram(String(message));
  res.json({ ok });
});

// Helper: distance % from UT Bot trailing stop
function fmtDist(close: number | undefined, ts: number | undefined): string {
  if (!close || !ts || ts <= 0) return "";
  const pct = ((close - ts) / ts) * 100;
  const sign = pct >= 0 ? "+" : "";
  const tag  = pct < 0 ? "↓" : pct <= 3 ? "🎯" : pct <= 8 ? "↑" : "↑";
  return `${tag}${sign}${pct.toFixed(1)}%`;
}

// Helper: distance label for one timeframe
function utBotLine(label: string, lv: { utBotAbove?: boolean; close?: number; utBotTs?: number } | undefined): string {
  if (!lv) return `  ${label}: ❓ 資料不足`;
  const above = lv.utBotAbove === true;
  const icon  = above ? "✅" : "❌";
  const dist  = fmtDist(lv.close, lv.utBotTs);
  const tsStr = lv.utBotTs && lv.utBotTs > 0 ? `止損 $${Number(lv.utBotTs).toFixed(2)}` : "";
  const parts = [tsStr, dist].filter(Boolean).join(" | ");
  return `  ${label}: ${icon} UT Bot ${above ? "趨勢向上" : "趨勢向下"}${parts ? `  (${parts})` : ""}`;
}

// POST /telegram/alert — send formatted resonance alert
router.post("/telegram/alert", async (req: Request, res: Response) => {
  const { symbol, resonanceScore, vcpPct, lastPrice, levels, bigTrend, h2Squeezed, m15Trigger } = req.body ?? {};
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const l = levels ?? {};

  // Distance summary line (月/週/日)
  const mDist = fmtDist(l.monthly?.close, l.monthly?.utBotTs);
  const wDist = fmtDist(l.weekly?.close,  l.weekly?.utBotTs);
  const dDist = fmtDist(l.daily?.close,   l.daily?.utBotTs);
  const distSummary = [mDist && `月${mDist}`, wDist && `週${wDist}`, dDist && `日${dDist}`]
    .filter(Boolean).join("  ");

  // 2H VCP line
  const vcpNum = vcpPct !== null && vcpPct !== undefined ? Number(vcpPct) : null;
  const vcpLine = vcpNum !== null
    ? `  2H:  ${vcpNum < 5 ? "✅" : "❌"} VCP ${vcpNum.toFixed(1)}%${vcpNum < 5 ? " (收縮中 🎯)" : " (未收縮)"}`
    : "  2H:  ❓ VCP 資料不足";

  // 15m UT Bot line
  const m15Buy  = l.m15?.utBotBuy === true;
  const m15Ts   = l.m15?.utBotTs && l.m15.utBotTs > 0 ? `止損 $${Number(l.m15.utBotTs).toFixed(2)}` : "";
  const m15Dist = fmtDist(l.m15?.close, l.m15?.utBotTs);
  const m15Parts = [m15Ts, m15Dist].filter(Boolean).join(" | ");
  const m15Line = `  15m: ${m15Buy ? "✅ UT Bot 金叉觸發 🚀" : "⏳ UT Bot 等待金叉"}${m15Parts ? `  (${m15Parts})` : ""}`;

  const message = [
    `🔥 <b>五級共振提示</b>`,
    ``,
    `📌 <b>${symbol}</b>  共振分: ${resonanceScore}/5`,
    `💰 最新價格: $${Number(lastPrice).toFixed(2)}`,
    distSummary ? `📏 距止損：${distSummary}` : "",
    ``,
    `<b>各週期狀態：</b>`,
    utBotLine("月線", l.monthly),
    utBotLine("週線", l.weekly),
    utBotLine("日線", l.daily),
    vcpLine,
    m15Line,
    ``,
    bigTrend   ? "✅ 大週期趨勢向上（月週日 UT Bot）" : "❌ 大週期趨勢未達標",
    h2Squeezed ? `✅ 2H VCP 收縮 (${vcpNum !== null ? vcpNum.toFixed(1) : "?"}% < 5%)` : "❌ 2H VCP 未收縮",
    m15Trigger ? "✅ 15m UT Bot 金叉（買點觸發）" : "⏳ 15m 等待 UT Bot 金叉",
    ``,
    `⚠️ 請人工確認後再行動`,
    `📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`,
  ].filter((l) => l !== "").join("\n");

  const ok = await sendTelegram(message);
  res.json({ ok, message });
});

// POST /telegram/test — test connectivity
router.post("/telegram/test", async (_req: Request, res: Response) => {
  const ok = await sendTelegram(
    `✅ 五級共振看盤系統已連線\n📅 ${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`
  );
  res.json({ ok });
});

export { sendTelegram };
export default router;
