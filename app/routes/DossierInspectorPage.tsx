import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import type { DossierArtifacts } from "../../server/api/types";
import { SourcesTable } from "../components/SourcesTable";
import { ClaimsTable } from "../components/ClaimsTable";
import { AgentRunList } from "../components/AgentRunList";
import { DossierInjectPanel } from "../components/DossierInjectPanel";

export function DossierInspectorPage() {
  const params: { date?: string; slug?: string } = useParams();
  const date = params.date || "";
  const slug = params.slug || "";
  
  const { data, loading, error, refresh } = useApi<DossierArtifacts>(`/api/dossier/${date}/${slug}`);
  const [activeTab, setActiveTab] = useState("header");
  
  if (loading && !data) return <div className="loading-dim">loading dossier…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;
  
  const dossier = data;
  
  const handleInject = async (notes: string, stage: string | null, requeue: boolean) => {
    const response = await authFetch(`/api/dossier/${date}/${slug}/inject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes, stage, requeue })
    });
    
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Failed to inject notes");
    }
    
    // Refresh the dossier data
    refresh();
  };
  
  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Dossier Inspector</div>
        <div className="page-subtitle">{dossier.header.headline || dossier.slug}</div>
        <div className="action-bar">
          <button className="btn btn-ghost" onClick={refresh}>Refresh</button>
        </div>
      </div>
      
      <div className="tabs">
        <button 
          className={`tab ${activeTab === "header" ? "active" : ""}`} 
          onClick={() => setActiveTab("header")}
        >
          Header
        </button>
        <button 
          className={`tab ${activeTab === "sources" ? "active" : ""}`} 
          onClick={() => setActiveTab("sources")}
        >
          Sources
        </button>
        <button 
          className={`tab ${activeTab === "claims" ? "active" : ""}`} 
          onClick={() => setActiveTab("claims")}
        >
          Claims
        </button>
        <button 
          className={`tab ${activeTab === "draft" ? "active" : ""}`} 
          onClick={() => setActiveTab("draft")}
        >
          Draft
        </button>
        <button 
          className={`tab ${activeTab === "verify" ? "active" : ""}`} 
          onClick={() => setActiveTab("verify")}
        >
          Verify
        </button>
        <button 
          className={`tab ${activeTab === "agent-runs" ? "active" : ""}`} 
          onClick={() => setActiveTab("agent-runs")}
        >
          Agent Runs
        </button>
        <button 
          className={`tab ${activeTab === "inject" ? "active" : ""}`} 
          onClick={() => setActiveTab("inject")}
        >
          Inject
        </button>
      </div>
      
      <div className="tab-content">
        {activeTab === "header" && (
          <div className="section-card">
            <div className="section-card-body">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="section-title">Story Identity</h3>
                  <table className="data-table">
                    <tbody>
                      <tr>
                        <td>Slug</td>
                        <td className="mono">{dossier.header.slug}</td>
                      </tr>
                      <tr>
                        <td>Headline</td>
                        <td>{dossier.header.headline}</td>
                      </tr>
                      <tr>
                        <td>Vertical</td>
                        <td>{dossier.header.vertical}</td>
                      </tr>
                      <tr>
                        <td>Owner</td>
                        <td>{dossier.header.owner}</td>
                      </tr>
                      <tr>
                        <td>Created</td>
                        <td>{dossier.header.created}</td>
                      </tr>
                      <tr>
                        <td>Last Updated</td>
                        <td>{dossier.header.updated}</td>
                      </tr>
                      <tr>
                        <td>Status</td>
                        <td>{dossier.header.status}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                
                <div>
                  <h3 className="section-title">Editorial Brief</h3>
                  <div className="prose">
                    <p><strong>Why This Story Matters:</strong></p>
                    <ul>
                      <li>Public importance: {dossier.header["Public importance"]}</li>
                      <li>News value: {dossier.header["News value"]}</li>
                      <li>Why now: {dossier.header["Why now"]}</li>
                      <li>Why NewsBites should cover it: {dossier.header["Why NewsBites should cover it"]}</li>
                    </ul>
                    
                    <p><strong>Core Angle:</strong></p>
                    <ul>
                      <li>One-sentence framing: {dossier.header["One-sentence framing"]}</li>
                      <li>What the story is not: {dossier.header["What the story is not"]}</li>
                    </ul>
                  </div>
                </div>
              </div>
              
              <h3 className="section-title">Research Notes</h3>
              <div className="prose">
                <pre>{dossier.header["Research Notes"]}</pre>
              </div>
            </div>
          </div>
        )}
        
        {activeTab === "sources" && (
          <div className="section-card">
            <div className="section-card-body">
              <SourcesTable sources={dossier.sources} />
            </div>
          </div>
        )}
        
        {activeTab === "claims" && (
          <div className="section-card">
            <div className="section-card-body">
              <ClaimsTable claims={dossier.claims} />
            </div>
          </div>
        )}
        
        {activeTab === "draft" && (
          <div className="section-card">
            <div className="section-card-body">
              <pre className="code-block">{dossier.draftContent}</pre>
            </div>
          </div>
        )}
        
        {activeTab === "verify" && (
          <div className="section-card">
            <div className="section-card-body">
              {dossier.verifyContent ? (
                <pre className="code-block">{dossier.verifyContent}</pre>
              ) : (
                <div className="loading-dim">No verification content found</div>
              )}
            </div>
          </div>
        )}
        
        {activeTab === "agent-runs" && (
          <div className="section-card">
            <div className="section-card-body">
              <AgentRunList agentRuns={dossier.agentRuns} />
            </div>
          </div>
        )}
        
        {activeTab === "inject" && (
          <div className="section-card">
            <div className="section-card-body">
              <DossierInjectPanel dossier={dossier} onInject={handleInject} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}