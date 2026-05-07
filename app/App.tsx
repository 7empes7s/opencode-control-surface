import { Router, Route, Switch } from "wouter";
import { DashNav } from "./components/DashNav";
import { DashHome } from "./routes/DashHome";
import { AutopipelinePage } from "./routes/AutopipelinePage";
import { DoctorPage } from "./routes/DoctorPage";
import { ModelsPage } from "./routes/ModelsPage";
import { NewsBitesPage } from "./routes/NewsBitesPage";
import { InfraPage } from "./routes/InfraPage";
import { IncidentsPage } from "./routes/IncidentsPage";
import { OpenCodeRoute } from "./routes/OpenCodeRoute";

function DashLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dash-root">
      <DashNav />
      {children}
    </div>
  );
}

export function App() {
  return (
    <Router>
      <Switch>
        <Route path="/opencode">
          <div className="shell">
            <OpenCodeRoute />
          </div>
        </Route>
        <Route path="/opencode/*">
          <div className="shell">
            <OpenCodeRoute />
          </div>
        </Route>

        <Route path="/autopipeline">
          <DashLayout><AutopipelinePage /></DashLayout>
        </Route>
        <Route path="/doctor">
          <DashLayout><DoctorPage /></DashLayout>
        </Route>
        <Route path="/models">
          <DashLayout><ModelsPage /></DashLayout>
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

        <Route>
          <DashLayout><DashHome /></DashLayout>
        </Route>
      </Switch>
    </Router>
  );
}
