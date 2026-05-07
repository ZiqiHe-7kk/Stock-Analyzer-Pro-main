import { useState, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetStocks, 
  useGetStocksSummary, 
  useGetStocksSectorBreakdown,
  getGetStocksQueryKey,
  getGetStocksSummaryQueryKey,
  getGetStocksSectorBreakdownQueryKey
} from "@workspace/api-client-react";
import { CSVLink } from "react-csv";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from "@/components/ui/table";
import {
  RefreshCw, ArrowUp, ArrowDown, ChevronDown, Check,
  Sun, Moon, Download, Printer
} from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import type { StockAnalysis } from "@workspace/api-client-react/src/generated/api.schemas";

const CHART_COLORS = {
  blue: "#0079F2",
  purple: "#795EFF",
  green: "#009118",
  red: "#A60808",
  pink: "#ec4899",
  neutral: "#71717a"
};

const CHART_COLOR_LIST = [
  CHART_COLORS.blue,
  CHART_COLORS.purple,
  CHART_COLORS.green,
  CHART_COLORS.red,
  CHART_COLORS.pink,
];

const DATA_SOURCES: string[] = ["市場數據", "分析師預測"];

const INTERVAL_OPTIONS = [
  { label: "每 5 分鐘", ms: 5 * 60 * 1000 },
  { label: "每 15 分鐘", ms: 15 * 60 * 1000 },
  { label: "每 1 小時", ms: 60 * 60 * 1000 },
  { label: "每 24 小時", ms: 24 * 60 * 60 * 1000 },
];

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        backgroundColor: "#fff",
        borderRadius: "6px",
        padding: "10px 14px",
        border: "1px solid #e0e0e0",
        color: "#1a1a1a",
        fontSize: "13px",
        boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
      }}
    >
      <div style={{ marginBottom: "6px", fontWeight: 500, display: "flex", alignItems: "center", gap: "6px" }}>
        {payload.length === 1 && payload[0].color && payload[0].color !== "#ffffff" && (
          <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: payload[0].color, flexShrink: 0 }} />
        )}
        {label}
      </div>
      {payload.map((entry: any, index: number) => (
        <div key={index} style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "3px" }}>
          {payload.length > 1 && entry.color && entry.color !== "#ffffff" && (
            <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: entry.color, flexShrink: 0 }} />
          )}
          <span style={{ color: "#444" }}>{entry.name}</span>
          <span style={{ marginLeft: "auto", fontWeight: 600 }}>
            {typeof entry.value === "number" ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function CustomLegend({ payload }: any) {
  if (!payload || payload.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px 16px", fontSize: "13px", marginTop: "12px" }}>
      {payload.map((entry: any, index: number) => (
        <div key={index} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: entry.color, flexShrink: 0 }} />
          <span>{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const stocksQuery = useGetStocks();
  const summaryQuery = useGetStocksSummary();
  const sectorBreakdownQuery = useGetStocksSectorBreakdown();

  const loading = 
    stocksQuery.isLoading || stocksQuery.isFetching ||
    summaryQuery.isLoading || summaryQuery.isFetching ||
    sectorBreakdownQuery.isLoading || sectorBreakdownQuery.isFetching;

  const [isDark, setIsDark] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [selectedIntervalMs, setSelectedIntervalMs] = useState(INTERVAL_OPTIONS[0].ms);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (loading) {
      setIsSpinning(true);
    } else {
      const t = setTimeout(() => setIsSpinning(false), 600);
      return () => clearTimeout(t);
    }
  }, [loading]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: getGetStocksQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetStocksSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetStocksSectorBreakdownQueryKey() });
    }, selectedIntervalMs);
    return () => clearInterval(t);
  }, [autoRefresh, selectedIntervalMs, queryClient]);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetStocksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStocksSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStocksSectorBreakdownQueryKey() });
  };

  const lastRefreshed = stocksQuery.dataUpdatedAt
    ? (() => {
        const d = new Date(stocksQuery.dataUpdatedAt);
        const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
        const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `${time} on ${date}`;
      })()
    : null;

  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "#e5e5e5";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const summary = summaryQuery.data;
  const sectors = sectorBreakdownQuery.data || [];
  const stocks = stocksQuery.data || [];

  // Prepare data for charts
  const pieData = summary ? [
    { name: "看漲 (Bullish)", value: summary.bullishCount, color: CHART_COLORS.green },
    { name: "中性 (Neutral)", value: summary.neutralCount, color: CHART_COLORS.neutral },
    { name: "看跌 (Bearish)", value: summary.bearishCount, color: CHART_COLORS.red }
  ] : [];

  const rankedStocks = useMemo(() => {
    return [...stocks].sort((a, b) => b.strengthScore - a.strengthScore);
  }, [stocks]);

  // Data Table
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const columns = useMemo<ColumnDef<StockAnalysis>[]>(() => [
    {
      accessorKey: "symbol",
      header: "代碼",
      cell: ({ row }) => <span className="font-bold text-sm">{row.original.symbol}</span>,
    },
    {
      accessorKey: "description",
      header: "名稱",
      cell: ({ row }) => <span className="text-muted-foreground truncate max-w-[150px] block" title={row.original.description}>{row.original.description}</span>,
    },
    {
      accessorKey: "price",
      header: "價格",
      cell: ({ row }) => <span className="font-mono text-sm">${row.original.price.toFixed(2)}</span>,
    },
    {
      accessorKey: "priceChange1d",
      header: "今日漲跌",
      cell: ({ row }) => {
        const val = row.original.priceChange1d;
        const color = val >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
        return <span className={`font-mono text-sm ${color}`}>{val > 0 ? '+' : ''}{val.toFixed(2)}%</span>;
      }
    },
    {
      accessorKey: "relativeVolume",
      header: "成交量倍率",
      cell: ({ row }) => {
        const val = row.original.relativeVolume;
        return <span className="font-mono text-sm">{val.toFixed(1)}x</span>;
      }
    },
    {
      accessorKey: "strengthScore",
      header: "強勢評分",
      cell: ({ row }) => {
        const val = row.original.strengthScore;
        const colorClass = val >= 70 ? "bg-green-500" : val <= 30 ? "bg-red-500" : "bg-blue-500";
        return (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs w-8">{Math.round(val)}</span>
            <Progress value={val} className="h-2 w-16" indicatorColorClass={colorClass} />
          </div>
        );
      }
    },
    {
      accessorKey: "trendOutlook",
      header: "趨勢展望",
      cell: ({ row }) => {
        const val = row.original.trendOutlook;
        if (val === "Bullish") return <Badge className="bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900 dark:text-green-200">看漲</Badge>;
        if (val === "Bearish") return <Badge className="bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900 dark:text-red-200">看跌</Badge>;
        return <Badge className="bg-gray-100 text-gray-800 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200" variant="outline">中性</Badge>;
      }
    },
    {
      accessorKey: "momentumSignal",
      header: "動能信號",
      cell: ({ row }) => <span className="text-xs">{row.original.momentumSignal}</span>,
    },
    {
      accessorKey: "sector",
      header: "板塊",
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.sector}</span>,
    }
  ], []);

  const table = useReactTable({
    data: stocks,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 15 } },
  });

  return (
    <div className="min-h-screen bg-background px-5 py-4 pt-[32px] pb-[32px] pl-[24px] pr-[24px]">
      <div className="max-w-[1400px] mx-auto">
        
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="pt-2">
            <h1 className="font-bold text-[32px]">股票強弱分析儀表板</h1>
            <p className="text-muted-foreground mt-1.5 text-[14px]">Stock Strength Analysis Dashboard</p>
            {DATA_SOURCES.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-[12px] text-muted-foreground shrink-0">
                  Data Sources:
                </span>
                {DATA_SOURCES.map((source) => (
                  <span
                    key={source}
                    className="text-[12px] font-bold rounded px-2 py-0.5 truncate print:!bg-[rgb(229,231,235)] print:!text-[rgb(75,85,99)]"
                    title={source}
                    style={{
                      maxWidth: "20ch",
                      backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "rgb(229, 231, 235)",
                      color: isDark ? "#c8c9cc" : "rgb(75, 85, 99)",
                    }}
                  >
                    {source}
                  </span>
                ))}
              </div>
            )}
            {lastRefreshed && <p className="text-[12px] text-muted-foreground mt-3">Last refresh: {lastRefreshed}</p>}
          </div>
          
          <div className="flex items-center gap-3 pt-2 print:hidden">
            {/* Split Refresh */}
            <div className="relative" ref={dropdownRef}>
              <div
                className="flex items-center rounded-[6px] overflow-hidden h-[26px] text-[12px]"
                style={{
                  backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "#F0F1F2",
                  color: isDark ? "#c8c9cc" : "#4b5563",
                }}
              >
                <button onClick={handleRefresh} disabled={loading} className="flex items-center gap-1 px-2 h-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50">
                  <RefreshCw className={`w-3.5 h-3.5 ${isSpinning ? "animate-spin" : ""}`} />
                  更新
                </button>
                <div className="w-px h-4 shrink-0" style={{ backgroundColor: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)" }} />
                <button onClick={() => setDropdownOpen((o) => !o)} className="flex items-center justify-center px-1.5 h-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
              {dropdownOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#1f2937] border border-gray-200 dark:border-gray-700 rounded shadow-lg z-50 py-1 text-sm overflow-hidden">
                  <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
                    <span className="font-medium">自動更新</span>
                    <button 
                      onClick={() => setAutoRefresh(!autoRefresh)}
                      className={`w-8 h-4 rounded-full transition-colors relative ${autoRefresh ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoRefresh ? 'translate-x-4' : ''}`} />
                    </button>
                  </div>
                  {INTERVAL_OPTIONS.map((opt) => (
                    <button
                      key={opt.ms}
                      onClick={() => { setSelectedIntervalMs(opt.ms); setAutoRefresh(true); setDropdownOpen(false); }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center justify-between"
                      disabled={!autoRefresh}
                      style={{ opacity: autoRefresh ? 1 : 0.5 }}
                    >
                      {opt.label}
                      {selectedIntervalMs === opt.ms && <Check className="w-4 h-4 text-blue-500" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={() => window.print()}
              disabled={loading}
              className="flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors disabled:opacity-50"
              style={{ backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "#F0F1F2", color: isDark ? "#c8c9cc" : "#4b5563" }}
              aria-label="Export as PDF"
            >
              <Printer className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsDark((d) => !d)}
              className="flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors"
              style={{ backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "#F0F1F2", color: isDark ? "#c8c9cc" : "#4b5563" }}
              aria-label="Toggle dark mode"
            >
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <Card>
            <CardContent className="p-6">
              {loading ? (
                <>
                  <Skeleton className="h-4 w-24 mb-2" />
                  <Skeleton className="h-8 w-32 mb-1" />
                  <Skeleton className="h-3 w-40" />
                </>
              ) : summary ? (
                <>
                  <p className="text-sm text-muted-foreground">總股票數 (Total Stocks)</p>
                  <p className="text-2xl font-bold mt-1" style={{ color: CHART_COLORS.blue }}>{summary.totalStocks}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <span className="text-green-600">看漲 {summary.bullishCount}</span>
                    <span className="text-gray-500">中性 {summary.neutralCount}</span>
                    <span className="text-red-600">看跌 {summary.bearishCount}</span>
                  </div>
                </>
              ) : (
                <><p className="text-sm text-muted-foreground">總股票數 (Total Stocks)</p><p className="text-2xl font-bold text-muted-foreground">--</p></>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              {loading ? (
                <>
                  <Skeleton className="h-4 w-24 mb-2" />
                  <Skeleton className="h-8 w-32" />
                </>
              ) : summary ? (
                <>
                  <p className="text-sm text-muted-foreground">平均強勢評分 (Avg Strength)</p>
                  <p className="text-2xl font-bold mt-1" style={{ color: CHART_COLORS.blue }}>{summary.avgStrengthScore.toFixed(1)}</p>
                </>
              ) : (
                <><p className="text-sm text-muted-foreground">平均強勢評分</p><p className="text-2xl font-bold text-muted-foreground">--</p></>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              {loading ? (
                <>
                  <Skeleton className="h-4 w-24 mb-2" />
                  <Skeleton className="h-8 w-32" />
                </>
              ) : summary ? (
                <>
                  <p className="text-sm text-muted-foreground">今日平均漲跌幅 (1D Change)</p>
                  <p className="text-2xl font-bold mt-1" style={{ color: summary.avgPriceChange1d >= 0 ? CHART_COLORS.green : CHART_COLORS.red }}>
                    {summary.avgPriceChange1d > 0 ? '+' : ''}{summary.avgPriceChange1d.toFixed(2)}%
                  </p>
                </>
              ) : (
                <><p className="text-sm text-muted-foreground">今日平均漲跌幅</p><p className="text-2xl font-bold text-muted-foreground">--</p></>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              {loading ? (
                <>
                  <Skeleton className="h-4 w-24 mb-2" />
                  <Skeleton className="h-8 w-32" />
                </>
              ) : summary ? (
                <>
                  <p className="text-sm text-muted-foreground">強力買入數量 (Strong Buy)</p>
                  <p className="text-2xl font-bold mt-1" style={{ color: CHART_COLORS.blue }}>{summary.strongBuyCount}</p>
                </>
              ) : (
                <><p className="text-sm text-muted-foreground">強力買入數量</p><p className="text-2xl font-bold text-muted-foreground">--</p></>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <Card>
            <CardHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">板塊強勢分佈 (Sector Strength)</CardTitle>
              {!loading && sectors.length > 0 && (
                <CSVLink data={sectors} filename="sector-strength.csv" className="print:hidden flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors hover:opacity-80" style={{ backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "#F0F1F2", color: isDark ? "#c8c9cc" : "#4b5563" }} aria-label="Export chart data as CSV">
                  <Download className="w-3.5 h-3.5" />
                </CSVLink>
              )}
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="w-full h-[300px]" /> : sectors.length > 0 ? (
                <ResponsiveContainer width="100%" height={300} debounce={0}>
                  <BarChart data={sectors} layout="vertical" margin={{ left: 30 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 12, fill: tickColor }} stroke={tickColor} domain={[0, 100]} />
                    <YAxis dataKey="sector" type="category" tick={{ fontSize: 12, fill: tickColor }} stroke={tickColor} width={80} />
                    <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                    <Bar dataKey="avgStrengthScore" name="平均強勢評分" fill={CHART_COLORS.blue} fillOpacity={0.8} activeBar={{ fillOpacity: 1 }} isAnimationActive={false} radius={[0, 2, 2, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-[300px] flex items-center justify-center text-muted-foreground">無資料</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">趨勢展望分佈 (Trend Distribution)</CardTitle>
              {!loading && pieData.length > 0 && (
                <CSVLink data={pieData} filename="trend-distribution.csv" className="print:hidden flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors hover:opacity-80" style={{ backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "#F0F1F2", color: isDark ? "#c8c9cc" : "#4b5563" }} aria-label="Export chart data as CSV">
                  <Download className="w-3.5 h-3.5" />
                </CSVLink>
              )}
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="w-full h-[300px]" /> : pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300} debounce={0}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={70} outerRadius={110} cornerRadius={2} paddingAngle={2} isAnimationActive={false} stroke="none">
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} isAnimationActive={false} />
                    <Legend content={<CustomLegend />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-[300px] flex items-center justify-center text-muted-foreground">無資料</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Strength Ranking Chart */}
        <Card className="mb-4">
          <CardHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">強勢排行榜 (Strength Ranking)</CardTitle>
            {!loading && rankedStocks.length > 0 && (
              <CSVLink data={rankedStocks} filename="strength-ranking.csv" className="print:hidden flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors hover:opacity-80" style={{ backgroundColor: isDark ? "rgba(255,255,255,0.1)" : "#F0F1F2", color: isDark ? "#c8c9cc" : "#4b5563" }} aria-label="Export chart data as CSV">
                <Download className="w-3.5 h-3.5" />
              </CSVLink>
            )}
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="w-full h-[400px]" /> : rankedStocks.length > 0 ? (
              <ResponsiveContainer width="100%" height={400} debounce={0}>
                <BarChart data={rankedStocks} margin={{ top: 20, right: 30, left: 20, bottom: 50 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                  <XAxis dataKey="symbol" tick={{ fontSize: 11, fill: tickColor }} stroke={tickColor} angle={-45} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 12, fill: tickColor }} stroke={tickColor} />
                  <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                  <Bar dataKey="strengthScore" name="強勢評分" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                    {rankedStocks.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.trendOutlook === 'Bullish' ? CHART_COLORS.green : entry.trendOutlook === 'Bearish' ? CHART_COLORS.red : CHART_COLORS.neutral} 
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="w-full h-[400px] flex items-center justify-center text-muted-foreground">無資料</div>
            )}
          </CardContent>
        </Card>

        {/* Data Table */}
        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-base">完整股票數據 (Stock Data)</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : (
              <div className="space-y-4">
                <Input
                  placeholder="搜尋股票代碼或名稱..."
                  value={globalFilter}
                  onChange={(e) => setGlobalFilter(e.target.value)}
                  className="max-w-sm"
                />

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      {table.getHeaderGroups().map((headerGroup) => (
                        <TableRow key={headerGroup.id}>
                          {headerGroup.headers.map((header) => (
                            <TableHead key={header.id} onClick={header.column.getToggleSortingHandler()} className="cursor-pointer select-none">
                              <div className="flex items-center gap-1 text-xs">
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {{ asc: " 🔼", desc: " 🔽" }[header.column.getIsSorted() as string] ?? null}
                              </div>
                            </TableHead>
                          ))}
                        </TableRow>
                      ))}
                    </TableHeader>
                    <TableBody>
                      {table.getRowModel().rows.length > 0 ? (
                        table.getRowModel().rows.map((row) => (
                          <TableRow key={row.id}>
                            {row.getVisibleCells().map((cell) => (
                              <TableCell key={cell.id} className="py-2">
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                            沒有符合的資料
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">
                    顯示 {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} 到{" "}
                    {Math.min((table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize, table.getFilteredRowModel().rows.length)}{" "}
                    共 {table.getFilteredRowModel().rows.length} 筆
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>上一頁</Button>
                    <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>下一頁</Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
