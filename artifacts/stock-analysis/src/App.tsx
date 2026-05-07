import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import Scanner from "@/pages/Scanner";
import { Activity, BarChart2 } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function NavBar() {
  const [location] = useLocation();
  return (
    <nav className="border-b bg-card/80 backdrop-blur sticky top-0 z-50">
      <div className="flex items-center gap-1 px-4 h-12">
        <span className="font-bold text-sm mr-4 text-foreground">📊 股票分析系統</span>
        <Link href="/">
          <button
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
              location === "/"
                ? "bg-blue-600 text-white"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            <BarChart2 className="h-4 w-4" />
            強弱儀表板
          </button>
        </Link>
        <Link href="/scanner">
          <button
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
              location === "/scanner"
                ? "bg-blue-600 text-white"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            <Activity className="h-4 w-4" />
            五級共振掃描器
          </button>
        </Link>
      </div>
    </nav>
  );
}

function Router() {
  return (
    <>
      <NavBar />
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/scanner" component={Scanner} />
        <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
