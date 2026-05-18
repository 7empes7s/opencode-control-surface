import { Router, Route, Switch } from "wouter";
import { DashSidebar } from "./components/DashSidebar";
import { DashHeader } from "./components/DashHeader";
import { DashHome } from "./routes/DashHome";
import { AutopipelinePage } from "./routes/AutopipelinePage";
import { DoctorPage } from "./routes/DoctorPage";
import { ModelsPage } from "./routes/ModelsPage";
import { NewsBitesPage } from "./routes/NewsBitesPage";
import { InfraPage } from "./routes/InfraPage";
import { IncidentsPage } from "./routes/IncidentsPage";
import { OpenCodeRoute } from "./routes/OpenCodeRoute";
import { CodexPage } from "./routes/CodexPage";
import { ClaudePage } from "./routes/ClaudePage";
import { JobsPage } from "./routes/JobsPage";
import { AuditPage } from "./routes/AuditPage";
import { TodayPage } from "./routes/TodayPage";
import { SettingsPage } from "./routes/SettingsPage";
import { BuilderPage } from "./routes/BuilderPage";
import { GeminiPage } from "./routes/GeminiPage";
import { TracePage } from "./routes/TracePage";
import { GatewayPage } from "./routes/GatewayPage";
import { LiteLLMPage } from "./routes/LiteLLMPage";
import { PaperclipPage } from "./routes/PaperclipPage";
import { GovernancePage } from "./routes/GovernancePage";
import { WorkflowsPage } from "./routes/WorkflowsPage";
import { ProjectsPage } from "./routes/ProjectsPage";
import { AboutPage } from "./routes/AboutPage";
import { MarketplacePage } from "./routes/MarketplacePage";
import { InstallWizardPage } from "./routes/InstallWizardPage";
import { CompliancePage } from "./routes/CompliancePage";
import { FinanceIntelPage } from "./routes/FinanceIntelPage";
import { DossierInspectorPage } from "./routes/DossierInspectorPage";
import { ChannelsPage } from "./routes/ChannelsPage";
import ScoutPage from "./routes/ScoutPage";
import { CostPage } from "./routes/CostPage";
import { AuthPrompt } from "./components/AuthPrompt";

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

export function App() {
  return (
    <Router>
      <AuthPrompt />
      <Switch>
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

        <Route path="/autopipeline">
          <DashLayout><AutopipelinePage /></DashLayout>
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
        <Route path="/paperclip">
          <DashLayout><PaperclipPage /></DashLayout>
        </Route>
        <Route path="/newsbites">
          <DashLayout><NewsBitesPage /></DashLayout>
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
          <DashLayout><InstallWizardPage /></DashLayout>
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
        <Route path="/compliance">
          <DashLayout><CompliancePage /></DashLayout>
        </Route>

        <Route>
          <DashLayout><DashHome /></DashLayout>
        </Route>
      </Switch>
    </Router>
  );
}
