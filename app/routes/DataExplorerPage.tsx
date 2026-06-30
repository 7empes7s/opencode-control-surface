import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Database, RefreshCw, Search } from "lucide-react";
import { useApi } from "../hooks/useApi";
import type { DataExplorerRowsPayload, DataExplorerTablesPayload } from "../../server/api/dataExplorer";

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function truncate(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

export function DataExplorerPage() {
  const [selectedTable, setSelectedTable] = useState("insights");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const tables = useApi<DataExplorerTablesPayload>("/api/data-explorer/tables", 30_000);
  const rowsPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (query) params.set("q", query);
    return `/api/data-explorer/table/${encodeURIComponent(selectedTable)}?${params.toString()}`;
  }, [selectedTable, offset, query]);
  const rows = useApi<DataExplorerRowsPayload>(rowsPath, 30_000);

  const tableList = tables.data?.tables ?? [];
  const selectedInfo = rows.data?.table ?? tableList.find((table) => table.name === selectedTable) ?? null;
  const columns = rows.data?.table.columns ?? selectedInfo?.columns ?? [];
  const total = rows.data?.total ?? 0;
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  function chooseTable(name: string) {
    setSelectedTable(name);
    setOffset(0);
  }

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setQuery(searchDraft.trim());
    setOffset(0);
  }

  return (
    <div className="dash-page">
      <div className="page-header" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="dash-section-title">advanced · read-only</div>
          <div className="page-title">Data Explorer</div>
        </div>
        <span className="pill amber">experimental</span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            tables.refresh();
            rows.refresh();
          }}
          style={{ minHeight: 44 }}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <section className="dash-section" style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)", gap: 16 }}>
        <aside style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <div className="dash-section-title">datasets</div>
          {tables.loading && !tables.data ? (
            <div className="loading-dim">loading tables...</div>
          ) : tables.error && !tables.data ? (
            <div className="loading-dim error">error: {tables.error}</div>
          ) : tableList.length === 0 ? (
            <div className="empty-state">
              <Database size={24} />
              <strong>No datasets available.</strong>
              <span>The dashboard database is disabled or empty.</span>
            </div>
          ) : (
            tableList.map((table) => (
              <button
                key={table.name}
                type="button"
                className={`btn ${selectedTable === table.name ? "" : "btn-ghost"}`}
                onClick={() => chooseTable(table.name)}
                style={{ minHeight: 44, justifyContent: "space-between" }}
              >
                <span>{table.label}</span>
                <span className="mono dim">{table.rowCount}</span>
              </button>
            ))
          )}
        </aside>

        <div style={{ minWidth: 0, display: "grid", gap: 12, alignContent: "start" }}>
          <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <div className="dash-section-title">{selectedInfo?.name ?? selectedTable}</div>
              <strong>{selectedInfo?.label ?? selectedTable}</strong>
              {selectedInfo?.description && <div className="dim" style={{ marginTop: 4 }}>{selectedInfo.description}</div>}
            </div>
            <form onSubmit={applySearch} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.currentTarget.value)}
                placeholder="Search rows"
                style={{ minHeight: 44, minWidth: 220 }}
              />
              <button type="submit" className="btn btn-ghost" style={{ minHeight: 44 }}>
                <Search size={15} />
                Search
              </button>
            </form>
          </div>

          {rows.loading && !rows.data ? (
            <div className="loading-dim">loading rows...</div>
          ) : rows.error && !rows.data ? (
            <div className="loading-dim error">error: {rows.error}</div>
          ) : rows.data?.rows.length === 0 ? (
            <div className="empty-state">
              <Database size={24} />
              <strong>No rows.</strong>
              <span>{query ? "No rows match the current search." : "This dataset has no rows yet."}</span>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column.name}>
                        {column.name}
                        {column.redacted && <span className="pill amber" style={{ marginLeft: 6 }}>redacted</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(rows.data?.rows ?? []).map((row, index) => (
                    <tr key={`${selectedTable}:${offset + index}`}>
                      {columns.map((column) => (
                        <td key={column.name} className={column.name === "id" ? "mono" : undefined}>
                          {truncate(displayValue(row[column.name]))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div className="mono dim">
              {total === 0 ? "0 rows" : `${offset + 1}-${Math.min(offset + limit, total)} of ${total}`}
              {query ? ` · q=${query}` : ""}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!canPrev}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                style={{ minHeight: 44 }}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!canNext}
                onClick={() => setOffset(offset + limit)}
                style={{ minHeight: 44 }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
