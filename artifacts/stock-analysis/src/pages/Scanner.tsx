import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Search, RefreshCw, Bell, Plus, Trash2, CheckCircle,
  Circle, AlertTriangle, TrendingUp, Activity, ChevronDown, ChevronUp,
  Play, Square, Zap, Clock, Settings2
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ---- Types ----
interface TimeframeResult {
  close: number;
  vcpPct: number | null;
  ema200ok: boolean;
  tsiOk: boolean;
  utBotAbove?: boolean;   // monthly / weekly / daily: trend confirmation
  utBotBuy?: boolean;     // 15m: fresh crossover buy signal
  utBotTs?: number;       // trailing stop value
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
  vcpPct: number | null;
  bigTrend: boolean;
  h2Squeezed: boolean;
  m15Trigger: boolean;
  levels: ScanResult["levels"] | null;
}

interface ManualWatchlistBatch {
  total: number;
  symbols: string[];
  results: ScanResult[];
}

interface ManualWatchlistState {
  symbols: string[];
  batches: number;
  scanned: number;
  results: ScanResult[];
  cursor: number;
}

interface MarketInfo {
  session: "pre-market" | "regular" | "after-hours" | "closed" | "weekend";
  label: string;
  etTime: string;
  nextOpenEt: string | null;
  isTrading: boolean;
}

interface AutoStatus {
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
  skippedCount: number;
  market: MarketInfo;
}

// ---- SP500 + NDX symbols batches (20 each) ----
const SCAN_BATCHES = [
  "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AVGO,JPM,LLY,V,UNH,XOM,MA,JNJ,PG,HD,COST,ABBV,MRK",
  "BAC,CVX,NFLX,WMT,AMD,ORCL,ADBE,CRM,TMO,LIN,ACN,MCD,DHR,CSCO,ABT,PEP,INTC,IBM,QCOM,TXN",
  "INTU,UNP,GS,MS,BLK,SPGI,SYK,MDT,ISRG,REGN,PLD,AMGN,BMY,CI,SCHW,NOW,AXP,CB,SO,DUK",
  "PANW,CRWD,SNPS,KLAC,MRVL,CDNS,AMAT,LRCX,MCHP,FTNT,WDAY,NXPI,ON,PCAR,ROST,ZS,TEAM,TMUS,BKNG,DXCM",
];

// ---- Helpers ----
async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

async function apiDelete(path: string) {
  await fetch(`${BASE}/api${path}`, { method: "DELETE" });
}

// ---- Distance from UT Bot trailing stop ----
function distPct(close: number, ts: number | undefined): number | null {
  if (!ts || ts <= 0 || close <= 0) return null;
  return ((close - ts) / ts) * 100;
}

function DistChip({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  const color =
    pct < 0      ? "bg-red-500/15 text-red-500 border-red-500/30" :
    pct <= 3     ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/40 font-bold" :
    pct <= 8     ? "bg-yellow-400/15 text-yellow-600 border-yellow-400/40" :
    pct <= 15    ? "bg-orange-400/10 text-orange-500 border-orange-400/30" :
    "bg-muted/40 text-muted-foreground border-border";
  const arrow = pct < 0 ? "↓" : pct <= 3 ? "🎯" : "↑";
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[11px] ${color}`}>
      <span className="font-mono opacity-60 mr-0.5">{label}</span>
      {arrow} {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

function StopDistanceBadges({ levels }: { levels: ScanResult["levels"] }) {
  const mDist = distPct(levels.monthly.close, levels.monthly.utBotTs);
  const wDist = distPct(levels.weekly.close,  levels.weekly.utBotTs);
  const dDist = distPct(levels.daily.close,   levels.daily.utBotTs);
  if (mDist === null && wDist === null && dDist === null) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap mt-1">
      <span className="text-[10px] text-muted-foreground mr-0.5">距止損：</span>
      <DistChip label="月" pct={mDist} />
      <DistChip label="週" pct={wDist} />
      <DistChip label="日" pct={dDist} />
    </div>
  );
}

// ---- Score badge ----
function ScoreBadge({ score }: { score: number }) {
  const colors =
    score === 5 ? "bg-emerald-500 text-white" :
    score === 4 ? "bg-green-400 text-white" :
    score === 3 ? "bg-yellow-400 text-black" :
    score === 2 ? "bg-orange-400 text-white" :
    "bg-red-400 text-white";
  return (
    <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-bold text-sm ${colors}`}>
      {score}
    </span>
  );
}

// ---- Level indicator row ----
function LevelRow({ label, ema, tsi, vcp, utBotAbove, utBotBuy, utBotTs, close }: {
  label: string;
  ema: boolean;
  tsi: boolean;
  vcp?: number | null;
  utBotAbove?: boolean;
  utBotBuy?: boolean;
  utBotTs?: number;
  close?: number;
}) {
  const is2H  = label === "2H";
  const isM15 = label === "15m";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-10 font-mono text-muted-foreground shrink-0">{label}</span>

      {isM15 ? (
        // 15m — UT Bot crossover buy signal (fresh entry)
        <>
          <span className={utBotBuy ? "text-emerald-500 font-semibold" : "text-muted-foreground"}>
            {utBotBuy ? "✅ UT Bot 金叉觸發 🚀" : "⏳ UT Bot 等待金叉"}
          </span>
          {utBotTs !== undefined && utBotTs > 0 && close !== undefined && (
            <span className="text-muted-foreground">
              止損線 ${utBotTs.toFixed(2)} / 現價 ${close.toFixed(2)}
            </span>
          )}
        </>
      ) : is2H ? (
        // 2H — VCP contraction filter (entry reserve)
        <>
          <span className={vcp !== null && vcp !== undefined && vcp < 5
            ? "text-sky-500 font-semibold"
            : "text-muted-foreground"
          }>
            {vcp !== null && vcp !== undefined
              ? (vcp < 5 ? `✅ VCP 收縮 ${vcp.toFixed(1)}% 🎯` : `❌ VCP 未收縮 ${vcp.toFixed(1)}%`)
              : "❌ VCP 資料不足"}
          </span>
        </>
      ) : (
        // Monthly / Weekly / Daily — UT Bot trend confirmation (above trailing stop)
        <>
          <span className={utBotAbove ? "text-emerald-500 font-semibold" : "text-muted-foreground"}>
            {utBotAbove ? "✅ UT Bot 趨勢向上" : "❌ UT Bot 趨勢向下"}
          </span>
          {utBotTs !== undefined && utBotTs > 0 && close !== undefined && (
            <span className="text-muted-foreground">
              止損線 ${utBotTs.toFixed(2)} / 現價 ${close.toFixed(2)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ---- ScanResult card ----
function ScanCard({ result, onAddToWatchlist }: {
  result: ScanResult;
  onAddToWatchlist: (r: ScanResult) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const l = result.levels;

  return (
    <Card className={`border-l-4 transition-all ${
      result.resonanceAchieved ? "border-l-emerald-500 bg-emerald-50/10" :
      result.resonanceScore >= 3 ? "border-l-yellow-400" :
      "border-l-border"
    }`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <ScoreBadge score={result.resonanceScore} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg">{result.symbol}</span>
              {result.resonanceAchieved && (
                <Badge className="bg-emerald-500 text-white text-xs">🔥 共振達成</Badge>
              )}
              {result.bigTrend && (
                <Badge variant="outline" className="text-xs border-green-500 text-green-600">大週期✓</Badge>
              )}
              {result.h2Squeezed && (
                <Badge variant="outline" className="text-xs border-blue-500 text-blue-600">VCP✓</Badge>
              )}
              {result.m15Trigger && (
                <Badge variant="outline" className="text-xs border-purple-500 text-purple-600">15m✓</Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground">
              ${result.lastPrice.toFixed(2)} &nbsp;|&nbsp;
              {result.vcpPct !== null ? `2H VCP: ${result.vcpPct.toFixed(1)}%` : "VCP: N/A"}
            </div>
            <StopDistanceBadges levels={result.levels} />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
            <Button
              size="sm"
              className="h-8 px-2 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => onAddToWatchlist(result)}
            >
              <Plus className="h-4 w-4 mr-1" /> 加入追蹤
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-3 pt-3 border-t space-y-1">
            <LevelRow label="月線" ema={l.monthly.ema200ok} tsi={l.monthly.tsiOk}
              utBotAbove={l.monthly.utBotAbove} utBotTs={l.monthly.utBotTs} close={l.monthly.close} />
            <LevelRow label="週線" ema={l.weekly.ema200ok} tsi={l.weekly.tsiOk}
              utBotAbove={l.weekly.utBotAbove} utBotTs={l.weekly.utBotTs} close={l.weekly.close} />
            <LevelRow label="日線" ema={l.daily.ema200ok} tsi={l.daily.tsiOk}
              utBotAbove={l.daily.utBotAbove} utBotTs={l.daily.utBotTs} close={l.daily.close} />
            <LevelRow label="2H" ema={l.h2.ema200ok} tsi={l.h2.tsiOk} vcp={l.h2.vcpPct} />
            <LevelRow label="15m" ema={l.m15.ema200ok} tsi={l.m15.tsiOk}
              utBotBuy={l.m15.utBotBuy} utBotTs={l.m15.utBotTs} close={l.m15.close} />
            <p className="text-xs text-muted-foreground pt-1">
              掃描時間：{new Date(result.scannedAt).toLocaleString("zh-TW")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Watchlist row ----
function WatchlistRow({ item, onConfirm, onAlert, onDelete, sending }: {
  item: WatchlistItem;
  onConfirm: () => void;
  onAlert: () => void;
  onDelete: () => void;
  sending: boolean;
}) {
  // Distance badges using stored levels snapshot
  const lvls = item.levels;
  const mDist = lvls ? distPct(lvls.monthly.close, lvls.monthly.utBotTs) : null;
  const wDist = lvls ? distPct(lvls.weekly.close,  lvls.weekly.utBotTs)  : null;
  const dDist = lvls ? distPct(lvls.daily.close,   lvls.daily.utBotTs)   : null;
  const hasDistData = mDist !== null || wDist !== null || dDist !== null;

  // Last alert time (formatted)
  const sentTimeStr = item.alertSentAt
    ? new Date(item.alertSentAt).toLocaleString("zh-TW", {
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      })
    : null;

  return (
    <div className={`p-3 rounded-lg border space-y-2 ${
      item.confirmed ? "border-emerald-500/40 bg-emerald-50/5" : "border-border"
    }`}>
      {/* Top row: score + symbol + badges + actions */}
      <div className="flex items-center gap-3">
        <ScoreBadge score={item.resonanceScore} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold">{item.symbol}</span>
            <Badge variant="outline" className="text-xs">
              {item.source === "manual" ? "手動加入" : "掃描加入"}
            </Badge>
            {item.confirmed && <Badge className="bg-emerald-500 text-white text-xs">✓ 已確認</Badge>}
            {item.m15Trigger && <Badge className="bg-blue-500 text-white text-xs">🚀 15m金叉</Badge>}
            {item.h2Squeezed && item.vcpPct !== null && (
              <Badge variant="outline" className="text-xs text-violet-400 border-violet-400">
                VCP {item.vcpPct.toFixed(1)}%
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            ${item.lastPrice.toFixed(2)} &nbsp;|&nbsp;
            加入：{new Date(item.addedAt).toLocaleDateString("zh-TW")}
            {item.note && <span> &nbsp;|&nbsp; {item.note}</span>}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button
            size="sm"
            variant={item.confirmed ? "default" : "outline"}
            className={`h-7 px-2 text-xs ${item.confirmed ? "bg-emerald-600 hover:bg-emerald-700" : ""}`}
            onClick={onConfirm}
          >
            <CheckCircle className="h-3 w-3 mr-1" />
            {item.confirmed ? "已確認" : "確認"}
          </Button>
          <Button
            size="sm"
            variant={item.alertSent ? "default" : "outline"}
            className={`h-7 px-2 text-xs ${
              item.alertSent
                ? "bg-orange-500 hover:bg-orange-600 text-white"
                : "hover:border-orange-400 hover:text-orange-400"
            }`}
            onClick={onAlert}
            disabled={sending}
          >
            {sending
              ? <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              : <Bell className="h-3 w-3 mr-1" />
            }
            {sending ? "發送中" : item.alertSent ? "重發 TG" : "推送 TG"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Distance badges row */}
      {hasDistData && (
        <div className="flex items-center gap-2 pl-9">
          <span className="text-xs text-muted-foreground">距止損</span>
          {mDist !== null && <DistChip label="月" pct={mDist} />}
          {wDist !== null && <DistChip label="週" pct={wDist} />}
          {dDist !== null && <DistChip label="日" pct={dDist} />}
          {sentTimeStr && (
            <span className="text-xs text-muted-foreground ml-auto">
              上次推送 {sentTimeStr}
            </span>
          )}
        </div>
      )}
      {!hasDistData && sentTimeStr && (
        <div className="pl-9 text-xs text-muted-foreground">
          上次推送 {sentTimeStr}
        </div>
      )}
    </div>
  );
}

// ---- Auto-scan panel component ----
function AutoScanPanel() {
  const { toast } = useToast();
  const [cfgInterval, setCfgInterval] = useState("");
  const [cfgMinScore, setCfgMinScore] = useState("");
  const [showCfg, setShowCfg] = useState(false);

  const { data: status, refetch: refetchStatus } = useQuery<AutoStatus>({
    queryKey: ["auto-status"],
    queryFn: () => apiGet<AutoStatus>("/scanner/auto-status"),
    refetchInterval: 10000,
  });

  const handleStart = async () => {
    const body: Record<string, number> = {};
    if (cfgInterval) body.intervalMinutes = Number(cfgInterval);
    if (cfgMinScore) body.minScoreAlert   = Number(cfgMinScore);
    await apiPost("/scanner/auto-start", body);
    await refetchStatus();
    toast({ title: `✅ 自動掃描已啟動，每 ${body.intervalMinutes ?? 30} 分鐘執行一次` });
  };

  const handleStop = async () => {
    await apiPost("/scanner/auto-stop", {});
    await refetchStatus();
    toast({ title: "⏹ 自動掃描已停止" });
  };

  const handleRunNow = async () => {
    const res = await apiPost<{ ok: boolean; message: string }>("/scanner/auto-run-now", {});
    toast({ title: res.message });
    setTimeout(() => { void refetchStatus(); }, 3000);
  };

  if (!status) return <Skeleton className="h-24 w-full rounded-xl" />;

  const mkt = status.market;
  const mktColor =
    mkt?.session === "regular"     ? "bg-emerald-500 text-white" :
    mkt?.session === "pre-market"  ? "bg-sky-500 text-white" :
    mkt?.session === "after-hours" ? "bg-orange-400 text-white" :
    "bg-muted text-muted-foreground";

  return (
    <Card className={`border-2 ${status.enabled ? "border-emerald-500/50 bg-emerald-50/5" : "border-border"}`}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Auto-scan status indicator */}
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              status.isRunning ? "bg-yellow-400 animate-pulse" :
              status.enabled   ? "bg-emerald-500 animate-pulse" :
              "bg-muted-foreground"
            }`} />
            <span className="font-semibold text-sm">
              {status.isRunning ? "掃描中…" : status.enabled ? "自動掃描運行中" : "自動掃描已停止"}
            </span>
          </div>

          {/* Market status badge */}
          {mkt && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${mktColor}`}>
              {mkt.session === "regular"     ? "🟢" :
               mkt.session === "pre-market"  ? "🌅" :
               mkt.session === "after-hours" ? "🌆" : "🔴"}
              {mkt.label}
              <span className="opacity-75 ml-0.5">ET {mkt.etTime}</span>
            </span>
          )}

          {/* Config summary */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-1">
            <span><Clock className="inline h-3 w-3 mr-1" />每 {status.intervalMinutes} 分鐘</span>
            <span><Bell className="inline h-3 w-3 mr-1" />≥ {status.minScoreAlert} 分推送</span>
            <span>{status.totalScanned} 支 / 第 {status.runCount} 次 / 跳過 {status.skippedCount} 次</span>
          </div>

          {/* Controls */}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setShowCfg(s => !s)}>
              <Settings2 className="h-3 w-3 mr-1" /> 設定
            </Button>
            <Button
              size="sm"
              className="h-7 px-2 text-xs bg-yellow-500 hover:bg-yellow-600 text-white"
              onClick={handleRunNow}
              disabled={status.isRunning}
              title="強制立即掃描（忽略市場時段）"
            >
              <Zap className="h-3 w-3 mr-1" /> 立即掃描
            </Button>
            {status.enabled ? (
              <Button size="sm" className="h-7 px-2 text-xs bg-red-600 hover:bg-red-700 text-white" onClick={handleStop}>
                <Square className="h-3 w-3 mr-1" /> 停止
              </Button>
            ) : (
              <Button size="sm" className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleStart}>
                <Play className="h-3 w-3 mr-1" /> 啟動
              </Button>
            )}
          </div>
        </div>

        {/* Time info row */}
        <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted-foreground">
          {status.lastRunAt && (
            <span>上次掃描：{new Date(status.lastRunAt).toLocaleString("zh-TW")}</span>
          )}
          {status.nextRunAt && status.enabled && mkt?.isTrading && (
            <span>下次：{new Date(status.nextRunAt).toLocaleString("zh-TW")}</span>
          )}
          {status.enabled && !mkt?.isTrading && mkt?.nextOpenEt && (
            <span className="text-sky-500 font-medium">
              ⏸ 休市暫停，下次開市：{new Date(mkt.nextOpenEt).toLocaleString("zh-TW")} 自動恢復
            </span>
          )}
          {mkt?.session === "pre-market" && (
            <span className="text-sky-400 font-medium">🌅 盤前模式 — 09:15 ET 自動觸發盤前掃描</span>
          )}
          {status.lastAlerted.length > 0 && (
            <span className="text-emerald-500 font-medium">
              上次提示：{status.lastAlerted.slice(0, 8).join(", ")}
              {status.lastAlerted.length > 8 ? ` +${status.lastAlerted.length - 8}` : ""}
            </span>
          )}
        </div>

        {/* Config panel */}
        {showCfg && (
          <div className="mt-3 pt-3 border-t flex flex-wrap gap-3 items-end">
            <div>
              <p className="text-xs text-muted-foreground mb-1">掃描間隔（分鐘）</p>
              <Input
                className="h-7 w-24 text-xs"
                placeholder={String(status.intervalMinutes)}
                value={cfgInterval}
                onChange={(e) => setCfgInterval(e.target.value)}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">TG 提示最低分</p>
              <div className="flex gap-1">
                {[3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setCfgMinScore(String(n))}
                    className={`w-7 h-7 rounded-full text-xs font-bold border transition-all ${
                      cfgMinScore === String(n) || (!cfgMinScore && status.minScoreAlert === n)
                        ? "bg-blue-600 text-white border-blue-600"
                        : "border-border text-muted-foreground hover:border-blue-400"
                    }`}
                  >{n}</button>
                ))}
              </div>
            </div>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={async () => {
                const body: Record<string, number> = {};
                if (cfgInterval) body.intervalMinutes = Number(cfgInterval);
                if (cfgMinScore) body.minScoreAlert   = Number(cfgMinScore);
                await apiPost(status.enabled ? "/scanner/auto-start" : "/scanner/auto-config" as "/scanner/auto-start", body);
                await refetchStatus();
                toast({ title: "設定已更新" });
                setShowCfg(false);
              }}
            >
              套用
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Main Scanner Page ----
export default function Scanner() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [scanSymbols, setScanSymbols] = useState("");
  const [manualWatchlist, setManualWatchlist] = useState("");
  const [manualBatchResults, setManualBatchResults] = useState<ScanResult[]>([]);
  const [manualScanState, setManualScanState] = useState<ManualWatchlistState | null>(null);
  const [activeBatch, setActiveBatch] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [filterMin, setFilterMin] = useState(3);
  const [sortBy, setSortBy] = useState<"score" | "dailyDist" | "weeklyDist">("score");

  // Watchlist
  const { data: watchlist = [], refetch: refetchWatchlist } = useQuery<WatchlistItem[]>({
    queryKey: ["watchlist"],
    queryFn: () => apiGet<WatchlistItem[]>("/watchlist"),
    refetchInterval: 30000,
  });

  // Scan handler
  const handleScan = useCallback(async (symbols: string) => {
    const sym = symbols.trim();
    if (!sym) return;
    setIsScanning(true);
    setActiveBatch(sym);
    try {
      const data = await apiGet<ScanResult[]>(`/scanner/scan?symbols=${encodeURIComponent(sym)}`);
      setScanResults(data);
      const achieved = data.filter((r) => r.resonanceAchieved).length;
      toast({
        title: `掃描完成`,
        description: `${data.length} 支掃描完成，${achieved} 支達成共振`,
      });
    } catch {
      toast({ title: "掃描失敗", description: "請確認 API 連線", variant: "destructive" });
    } finally {
      setIsScanning(false);
    }
  }, [toast]);

  const handleBatchScan = useCallback(async (batchIdx: number) => {
    await handleScan(SCAN_BATCHES[batchIdx]);
  }, [handleScan]);

  const handleManualWatchlistScan = useCallback(async () => {
    const symbols = manualWatchlist
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) return;
    setIsScanning(true);
    try {
      const res = await apiPost<ManualWatchlistBatch>("/scanner/watchlist-scan", { symbols: manualWatchlist });
      setManualBatchResults(res.results);
      setScanResults(res.results);
      setManualScanState({
        symbols: res.symbols,
        batches: Math.ceil(res.symbols.length / 20),
        scanned: res.total,
        results: res.results,
        cursor: 0,
      });
      toast({ title: `已掃描手動 watchlist：${res.total} 支` });
    } catch {
      toast({ title: "手動 watchlist 掃描失敗", variant: "destructive" });
    } finally {
      setIsScanning(false);
    }
  }, [manualWatchlist, toast]);

  const handleWatchlistBatch = useCallback(async () => {
    setIsScanning(true);
    try {
      const res = await apiGet<{ symbols: string[]; total: number; results: ScanResult[] }>("/watchlist/batch");
      if (res.total === 0) {
        toast({ title: "追蹤清單目前是空的" });
        return;
      }
      setManualScanState((prev) => {
        const nextCursor = (prev?.cursor ?? 0) + 1;
        const baseSymbols = prev?.symbols.length ? prev.symbols : res.symbols;
        return {
          symbols: baseSymbols,
          batches: Math.ceil(baseSymbols.length / 20),
          scanned: res.total,
          results: res.results,
          cursor: nextCursor,
        };
      });
      setScanResults(res.results);
      toast({ title: `已掃描追蹤清單批次：${res.total} 支` });
    } catch {
      toast({ title: "追蹤清單批次掃描失敗", variant: "destructive" });
    } finally {
      setIsScanning(false);
    }
  }, [toast]);

  // Add to watchlist — store full scan snapshot for TG alert
  const addToWatchlist = useCallback(async (r: ScanResult) => {
    try {
      await apiPost("/watchlist", {
        symbol: r.symbol,
        resonanceScore: r.resonanceScore,
        lastPrice: r.lastPrice,
        vcpPct: r.vcpPct,
        bigTrend: r.bigTrend,
        h2Squeezed: r.h2Squeezed,
        m15Trigger: r.m15Trigger,
        levels: r.levels,
      });
      await refetchWatchlist();
      toast({ title: `${r.symbol} 已加入追蹤清單` });
    } catch {
      toast({ title: "加入失敗", variant: "destructive" });
    }
  }, [refetchWatchlist, toast]);

  // Confirm watchlist item
  const confirmItem = useCallback(async (item: WatchlistItem) => {
    await apiPatch(`/watchlist/${item.id}`, { confirmed: !item.confirmed });
    await refetchWatchlist();
  }, [refetchWatchlist]);

  // Per-item TG sending state
  const [sendingId, setSendingId] = useState<string | null>(null);

  // Send TG alert — prefer live scan data, fall back to stored watchlist snapshot
  const sendAlert = useCallback(async (item: WatchlistItem) => {
    setSendingId(item.id);
    try {
      const live = scanResults.find((r) => r.symbol === item.symbol);
      await apiPost("/telegram/alert", {
        symbol: item.symbol,
        resonanceScore: live?.resonanceScore ?? item.resonanceScore,
        lastPrice: live?.lastPrice ?? item.lastPrice,
        vcpPct: live?.vcpPct ?? item.vcpPct ?? null,
        levels: live?.levels ?? item.levels ?? null,
        bigTrend: live?.bigTrend ?? item.bigTrend ?? false,
        h2Squeezed: live?.h2Squeezed ?? item.h2Squeezed ?? false,
        m15Trigger: live?.m15Trigger ?? item.m15Trigger ?? false,
      });
      await apiPatch(`/watchlist/${item.id}`, { alertSent: true });
      await refetchWatchlist();
      toast({ title: `✅ TG 提示已推送：${item.symbol}` });
    } catch {
      toast({ title: "TG 發送失敗", variant: "destructive" });
    } finally {
      setSendingId(null);
    }
  }, [scanResults, refetchWatchlist, toast]);

  // Delete watchlist item
  const deleteItem = useCallback(async (item: WatchlistItem) => {
    await apiDelete(`/watchlist/${item.id}`);
    await refetchWatchlist();
    toast({ title: `${item.symbol} 已從追蹤清單移除` });
  }, [refetchWatchlist, toast]);

  // Test TG
  const testTelegram = useCallback(async () => {
    try {
      const res = await apiPost<{ ok: boolean }>("/telegram/test", {});
      toast({
        title: res.ok ? "✅ Telegram 連線正常" : "❌ Telegram 發送失敗",
        description: res.ok ? "已發送測試訊息至你的 Bot" : "請檢查 Token 和 Chat ID",
        variant: res.ok ? "default" : "destructive",
      });
    } catch {
      toast({ title: "連線測試失敗", variant: "destructive" });
    }
  }, [toast]);

  const filteredResults = useMemo(() => {
    const filtered = scanResults.filter((r) => r.resonanceScore >= filterMin);

    const getDist = (r: ScanResult, tf: "daily" | "weekly") => {
      const lv = r.levels[tf];
      const d = distPct(lv.close, lv.utBotTs);
      // push nulls / negatives to end; positive small = best
      if (d === null) return 9999;
      if (d < 0) return 9000 + Math.abs(d); // below stop → near end
      return d;
    };

    return [...filtered].sort((a, b) => {
      if (sortBy === "dailyDist")  return getDist(a, "daily")  - getDist(b, "daily");
      if (sortBy === "weeklyDist") return getDist(a, "weekly") - getDist(b, "weekly");
      // default: score desc, then daily dist asc (tiebreak)
      if (b.resonanceScore !== a.resonanceScore) return b.resonanceScore - a.resonanceScore;
      return getDist(a, "daily") - getDist(b, "daily");
    });
  }, [scanResults, filterMin, sortBy]);
  const resonantCount = scanResults.filter((r) => r.resonanceAchieved).length;
  const confirmedCount = watchlist.filter((w) => w.confirmed).length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="h-6 w-6 text-blue-500" />
              五級共振掃描器
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              月/週/日 UT Bot 趨勢確認 → 2H VCP 收縮進儲備 → 15m UT Bot 金叉買點 → TG 人工確認
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={testTelegram}>
            <Bell className="h-4 w-4 mr-2" /> 測試 TG
          </Button>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6 max-w-7xl mx-auto">
        {/* Auto-scan panel */}
        <AutoScanPanel />

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "已掃描", value: scanResults.length, icon: <Search className="h-4 w-4 text-blue-500" /> },
            { label: "共振達成", value: resonantCount, icon: <TrendingUp className="h-4 w-4 text-emerald-500" />, highlight: resonantCount > 0 },
            { label: "追蹤清單", value: watchlist.length, icon: <Circle className="h-4 w-4 text-yellow-500" /> },
            { label: "人工確認", value: confirmedCount, icon: <CheckCircle className="h-4 w-4 text-purple-500" /> },
          ].map((kpi) => (
            <Card key={kpi.label} className={kpi.highlight ? "border-emerald-500" : ""}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                  {kpi.icon} {kpi.label}
                </div>
                <div className={`text-3xl font-bold ${kpi.highlight ? "text-emerald-500" : ""}`}>
                  {kpi.value}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Scanner controls + results */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Search className="h-4 w-4" /> 掃描控制
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Custom symbols */}
                <div className="flex gap-2">
                  <Input
                    placeholder="自訂股票代碼，逗號分隔，例：AAPL,NVDA,TSLA（最多20支）"
                    value={scanSymbols}
                    onChange={(e) => setScanSymbols(e.target.value)}
                    className="text-sm"
                  />
                  <Button
                    className="shrink-0 bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={() => handleScan(scanSymbols)}
                    disabled={isScanning || !scanSymbols.trim()}
                  >
                    {isScanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>

                {/* Batch scan buttons */}
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">S&P 500 / NASDAQ 100 分批掃描（每批20支）：</p>
                  <div className="flex flex-wrap gap-2">
                    {SCAN_BATCHES.map((batch, i) => (
                      <Button
                        key={i}
                        size="sm"
                        variant={activeBatch === batch ? "default" : "outline"}
                        className="text-xs h-7"
                        onClick={() => handleBatchScan(i)}
                        disabled={isScanning}
                      >
                        {isScanning && activeBatch === batch
                          ? <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                          : null}
                        批次 {i + 1}（{batch.split(",").slice(0, 3).join(",")}...）
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t">
                  <p className="text-xs text-muted-foreground">手動 watchlist（可存很多支，掃描每批 20 支）：</p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="例如：AAPL,NVDA,TSLA，最多可存很多支"
                      value={manualWatchlist}
                      onChange={(e) => setManualWatchlist(e.target.value)}
                      className="text-sm"
                    />
                    <Button
                      className="shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={handleManualWatchlistScan}
                      disabled={isScanning || !manualWatchlist.trim()}
                    >
                      {isScanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full text-xs h-8"
                    onClick={handleWatchlistBatch}
                    disabled={isScanning || watchlist.length === 0}
                  >
                    {isScanning ? "輪巡中..." : "開始輪巡追蹤清單（每次 20 支）"}
                  </Button>
                </div>

                {/* Filter + Sort */}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <span className="text-xs text-muted-foreground">最低共振分：</span>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setFilterMin(n)}
                      className={`w-7 h-7 rounded-full text-xs font-bold border transition-all ${
                        filterMin === n
                          ? "bg-blue-600 text-white border-blue-600"
                          : "border-border text-muted-foreground hover:border-blue-400"
                      }`}
                    >
                      {n}
                    </button>
                  ))}

                  <span className="text-xs text-muted-foreground border-l border-border pl-3 ml-1">排序：</span>
                  {(["score", "dailyDist", "weeklyDist"] as const).map((opt) => {
                    const label = opt === "score" ? "共振分" : opt === "dailyDist" ? "日線距止損↑" : "週線距止損↑";
                    return (
                      <button
                        key={opt}
                        onClick={() => setSortBy(opt)}
                        className={`px-2 h-7 rounded text-xs border transition-all ${
                          sortBy === opt
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "border-border text-muted-foreground hover:border-emerald-400"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}

                  <span className="text-xs text-muted-foreground ml-auto">顯示 {filteredResults.length} 支</span>
                </div>
              </CardContent>
            </Card>

            {/* Scan results */}
            <div className="space-y-3">
              {isScanning ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))
              ) : filteredResults.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Search className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p>選擇批次或輸入代碼開始掃描</p>
                  <p className="text-xs mt-1">五級共振：月/週/日 UT Bot 趨勢確認 → 2H VCP 收縮 &lt;5% → 15m UT Bot 金叉買入</p>
                </div>
              ) : (
                filteredResults.map((r) => (
                  <ScanCard key={r.symbol} result={r} onAddToWatchlist={addToWatchlist} />
                ))
              )}
              {manualScanState && (
                <div className="text-xs text-muted-foreground text-center pt-1 space-y-1">
                  <div>手動 watchlist：{manualScanState.symbols.length} 支，分成 {manualScanState.batches} 批，每批最多 20 支</div>
                  <div>最近掃描結果：{manualScanState.scanned} 支，達成共振 {manualScanState.results.filter((r) => r.resonanceAchieved).length} 支</div>
                </div>
              )}
            </div>
          </div>

          {/* Right: Watchlist */}
          <div className="space-y-4">
            <Card className="sticky top-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <CheckCircle className="h-4 w-4" /> 人工確認追蹤清單
                  <span className="ml-auto text-xs text-muted-foreground font-normal">
                    {watchlist.length} 支 / {confirmedCount} 確認
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                {watchlist.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">清單為空</p>
                    <p className="text-xs">從左側掃描結果加入追蹤</p>
                  </div>
                ) : (
                  watchlist.map((item) => (
                    <WatchlistRow
                      key={item.id}
                      item={item}
                      onConfirm={() => confirmItem(item)}
                      onAlert={() => sendAlert(item)}
                      onDelete={() => deleteItem(item)}
                      sending={sendingId === item.id}
                    />
                  ))
                )}
              </CardContent>
            </Card>

            {/* Legend */}
            <Card>
              <CardContent className="p-4 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">五級共振說明</p>
                {[
                  ["月線", "UT Bot 趨勢確認：價格在 ATR 止損線上方（長期向上）"],
                  ["週線", "UT Bot 趨勢確認：價格在 ATR 止損線上方（中期向上）"],
                  ["日線", "UT Bot 趨勢確認：價格在 ATR 止損線上方（短期向上）"],
                  ["2H",  "VCP 收縮：20 根高低點差 < 5% → 進入儲備標的"],
                  ["15m", "UT Bot 金叉：價格向上穿越止損線 → 實際買入訊號"],
                ].map(([label, desc]) => (
                  <div key={label} className="flex gap-2 text-xs">
                    <span className="font-mono w-10 text-muted-foreground shrink-0">{label}</span>
                    <span className="text-muted-foreground">{desc}</span>
                  </div>
                ))}
                <div className="pt-2 border-t">
                  <div className="flex gap-2 text-xs">
                    <span className="text-emerald-500 font-bold">🔥 共振達成</span>
                    <span className="text-muted-foreground">= 全部5級同時滿足</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
