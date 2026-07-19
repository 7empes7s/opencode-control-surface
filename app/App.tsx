import { useEffect, useRef } from "react";
import { Router, Route, Switch, useLocation } from "wouter";
import { DashSidebar } from "./components/DashSidebar";
import { DashHeader } from "./components/DashHeader";
import { DashHome } from "./routes/DashHome";
import { AutopipelinePage } from "./routes/AutopipelinePage";
import { DoctorPage } from "./routes/DoctorPage";
import { ModelsPage } from "./routes/ModelsPage";
import { NewsBitesPage } from "./routes/NewsBitesPage";
import { KnowPage } from "./routes/KnowPage";
import { InfraPage } from "./routes/InfraPage";
import { IncidentsPage } from "./routes/IncidentsPage";
import { OpenCodeRoute } from "./routes/OpenCodeRoute";
import { CodexPage } from "./routes/CodexPage";
import { ClaudePage } from "./routes/ClaudePage";
import { JobsPage } from "./routes/JobsPage";
import { AuditPage } from "./routes/AuditPage";
import { AgentTeamPage } from "./routes/AgentTeamPage";
import { TodayPage } from "./routes/TodayPage";
import { SettingsPage } from "./routes/SettingsPage";
import { BuilderPage } from "./routes/BuilderPage";
import { GeminiPage } from "./routes/GeminiPage";
import { TracePage } from "./routes/TracePage";
import { GatewayPage } from "./routes/GatewayPage";
import { LiteLLMPage } from "./routes/LiteLLMPage";
import { GovernancePage } from "./routes/GovernancePage";
import { WorkflowsPage } from "./routes/WorkflowsPage";
import { RunbooksPage } from "./routes/RunbooksPage";
import { ProjectsPage } from "./routes/ProjectsPage";
import { AboutPage } from "./routes/AboutPage";
import { MarketplacePage } from "./routes/MarketplacePage";
import { InstallPage } from "./routes/InstallPage";
import { CompliancePage } from "./routes/CompliancePage";
import { FinanceIntelPage } from "./routes/FinanceIntelPage";
import { DossierInspectorPage } from "./routes/DossierInspectorPage";
import { ChannelsPage } from "./routes/ChannelsPage";
import { ContentHealthPage } from "./routes/ContentHealthPage";
import { ReportsPage } from "./routes/ReportsPage";
import { DataExplorerPage } from "./routes/DataExplorerPage";
import ScoutPage from "./routes/ScoutPage";
import BrainstormPage from "./routes/BrainstormPage";
import { CostPage } from "./routes/CostPage";
import { InsightsPage } from "./routes/InsightsPage";
import { FeatureFlagsPage } from "./routes/FeatureFlagsPage";
import { SecurityPage } from "./routes/SecurityPage";
import { AgentRegistryPage } from "./routes/AgentRegistryPage";
import { StatusPage } from "./routes/StatusPage";
import { AdminPage } from "./routes/AdminPage";
import { TerminalPage } from "./routes/TerminalPage";
import { AuthPrompt } from "./components/AuthPrompt";
import { CommandPalette, useCommandPalette } from "./components/CommandPalette";
import { authFetch } from "./lib/authFetch";

function UsageBeacon() {
  const [location] = useLocation();
  const pendingPaths = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pendingPaths.current.push(location);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      while (pendingPaths.current.length > 0) {
        const events = pendingPaths.current.splice(0, 50).map((path) => ({ path }));
        void authFetch("/api/usage/beacon", {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
        }).catch(() => undefined);
      }
    }, 250);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [location]);

  return null;
}

function DashLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dash-shell">
      <DashSidebar />
      <main className="dash-main">
        <div className="dash-content">
          <DashHeader />
          {children}
        </div>
      </main>
    </div>
  );
}

// Bare layout: sidebar + main, but no DashHeader and no extra padding.
// Used for chat-style pages (OpenCode, Codex, Claude) that bring their own topbar.
function DashLayoutBare({ children }: { children: React.ReactNode }) {
  return (
    <div className="dash-shell">
      <DashSidebar />
      <main className="dash-main bare">{children}</main>
    </div>
  );
}

// Public layout: no sidebar, no header. Used for the public status page
// (and anything else intended to be reachable without auth, from anywhere).
function PublicLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { open, onClose } = useCommandPalette();
  return (
    <>
      <UsageBeacon />
      {children}
      <CommandPalette open={open} onClose={onClose} />
    </>
  );
}

export function App() {
  return (
    <Router>
      <AppShell>
      <AuthPrompt />
      <Switch>
        <Route path="/status">
          <PublicLayout><StatusPage /></PublicLayout>
        </Route>
        <Route path="/opencode">
          <DashLayoutBare><OpenCodeRoute /></DashLayoutBare>
        </Route>
        <Route path="/opencode/*">
          <DashLayoutBare><OpenCodeRoute /></DashLayoutBare>
        </Route>
        <Route path="/codex">
          <DashLayoutBare><CodexPage /></DashLayoutBare>
        </Route>
        <Route path="/claude">
          <DashLayoutBare><ClaudePage /></DashLayoutBare>
        </Route>
        <Route path="/gemini">
          <DashLayoutBare><GeminiPage /></DashLayoutBare>
        </Route>
        <Route path="/terminal">
          <DashLayoutBare><TerminalPage /></DashLayoutBare>
        </Route>

        <Route path="/admin">
          <DashLayout><AdminPage /></DashLayout>
        </Route>
        <Route path="/autopipeline">
          <DashLayout><AutopipelinePage /></DashLayout>
        </Route>
        <Route path="/insights">
          <DashLayout><InsightsPage /></DashLayout>
        </Route>
        <Route path="/security">
          <DashLayout><SecurityPage /></DashLayout>
        </Route>
        <Route path="/agents">
          <DashLayout><AgentRegistryPage /></DashLayout>
        </Route>
        <Route path="/autopipeline/dossier/:date/:slug">
          <DashLayout><DossierInspectorPage /></DashLayout>
        </Route>
        <Route path="/scout">
          <DashLayout><ScoutPage /></DashLayout>
        </Route>
        <Route path="/doctor">
          <DashLayout><DoctorPage /></DashLayout>
        </Route>
        <Route path="/models">
          <DashLayout><ModelsPage /></DashLayout>
        </Route>
        <Route path="/litellm">
          <DashLayout><LiteLLMPage /></DashLayout>
        </Route>
        <Route path="/newsbites">
          <DashLayout><NewsBitesPage /></DashLayout>
        </Route>
        <Route path="/know">
          <DashLayout><KnowPage /></DashLayout>
        </Route>
        <Route path="/infra">
          <DashLayout><InfraPage /></DashLayout>
        </Route>
        <Route path="/incidents">
          <DashLayout><IncidentsPage /></DashLayout>
        </Route>
        <Route path="/jobs">
          <DashLayout><JobsPage /></DashLayout>
        </Route>
        <Route path="/agent-team">
          <DashLayout><AgentTeamPage /></DashLayout>
        </Route>
        <Route path="/audit">
          <DashLayout><AuditPage /></DashLayout>
        </Route>
        <Route path="/today">
          <DashLayout><TodayPage /></DashLayout>
        </Route>
        <Route path="/settings">
          <DashLayout><SettingsPage /></DashLayout>
        </Route>
        <Route path="/builder">
          <DashLayout><BuilderPage /></DashLayout>
        </Route>
        <Route path="/brainstorm">
          <DashLayout><BrainstormPage /></DashLayout>
        </Route>
        <Route path="/governance">
          <DashLayout><GovernancePage /></DashLayout>
        </Route>
        <Route path="/traces">
          <DashLayout><TracePage /></DashLayout>
        </Route>
        <Route path="/gateway">
          <DashLayout><GatewayPage /></DashLayout>
        </Route>
        <Route path="/workflows">
          <DashLayout><WorkflowsPage /></DashLayout>
        </Route>
        <Route path="/runbooks">
          <DashLayout><RunbooksPage /></DashLayout>
        </Route>
        <Route path="/projects">
          <DashLayout><ProjectsPage /></DashLayout>
        </Route>
        <Route path="/about">
          <DashLayout><AboutPage /></DashLayout>
        </Route>
        <Route path="/marketplace">
          <DashLayout><MarketplacePage /></DashLayout>
        </Route>
        <Route path="/install">
          <DashLayout><InstallPage /></DashLayout>
        </Route>
        <Route path="/cost">
          <DashLayout><CostPage /></DashLayout>
        </Route>
        <Route path="/finance-intel">
          <DashLayout><FinanceIntelPage /></DashLayout>
        </Route>
        <Route path="/channels">
          <DashLayout><ChannelsPage /></DashLayout>
        </Route>
        <Route path="/content-health">
          <DashLayout><ContentHealthPage /></DashLayout>
        </Route>
        <Route path="/reports">
          <DashLayout><ReportsPage /></DashLayout>
        </Route>
        <Route path="/data-explorer">
          <DashLayout><DataExplorerPage /></DashLayout>
        </Route>
        <Route path="/compliance">
          <DashLayout><CompliancePage /></DashLayout>
        </Route>
        <Route path="/feature-flags">
          <DashLayout><FeatureFlagsPage /></DashLayout>
        </Route>

        <Route>
          <DashLayout><DashHome /></DashLayout>
        </Route>
      </Switch>
      </AppShell>
    </Router>
  );
}
