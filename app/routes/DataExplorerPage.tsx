import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Database, RefreshCw } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { TableControls } from "../components/TableControls";
import { useTableControls } from "../hooks/useTableControls";
import type { DataExplorerRowsPayload, DataExplorerTablesPayload } from "../../server/api/dataExplorer";

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function isLongColumn(name: string): boolean {
  return /plain_summary|json|payload|request|response|result|attrs|evidence|suggested_actions|post_mortem|resolution|reason|error/i.test(name);
}

function columnClass(name: string): string {
  if (name === "id" || name.endsWith("_id") || name.includes("trace")) return "mono cell-ellipsis";
  if (name === "domain" || name === "title" || name.includes("model")) return "cell-ellipsis cell-wide";
  return "cell-ellipsis";
}

export function DataExplorerPage() {
  const [selectedTable, setSelectedTable] = useState("insights");
  const limit = 200;

  const tables = useApi<DataExplorerTablesPayload>("/api/data-explorer/tables", 30_000);
  const rowsPath = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: "0",
    });
    return `/api/data-explorer/table/${encodeURIComponent(selectedTable)}?${params.toString()}`;
  }, [selectedTable]);
  const rows = useApi<DataExplorerRowsPayload>(rowsPath, 30_000);

  const tableList = tables.data?.tables ?? [];
  const selectedInfo = rows.data?.table ?? tableList.find((table) => table.name === selectedTable) ?? null;
  const columns = rows.data?.table.columns ?? selectedInfo?.columns ?? [];
  const total = rows.data?.total ?? 0;
  const visibleColumns = useMemo(() => {
    const compact = columns.filter((column) => !isLongColumn(column.name));
    return (compact.length > 0 ? compact : columns).slice(0, 8);
  }, [columns]);
  const tableRows = rows.data?.rows ?? [];
  const rowControls = useTableControls<Record<string, unknown>, string>({
    rows: tableRows,
    pageSize: 25,
    pageSizeOptions: [10, 25, 50, 100],
    rowKey: (row) => `${selectedTable}:${displayValue(row.id) || tableRows.indexOf(row)}`,
    filterText: (row) => columns.map((column) => displayValue(row[column.name])),
    sortValue: (row, key) => displayValue(row[key]),
  });

  function chooseTable(name: string) {
    setSelectedTable(name);
    rowControls.collapseAll();
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
            {total > limit && (
              <span className="pill amber" title="The read-only endpoint safely caps each explorer read.">
                first {limit} of {total}
              </span>
            )}
          </div>

          {rows.loading && !rows.data ? (
            <div className="loading-dim">loading rows...</div>
          ) : rows.error && !rows.data ? (
            <div className="loading-dim error">error: {rows.error}</div>
          ) : rows.data?.rows.length === 0 ? (
            <div className="empty-state">
              <Database size={24} />
              <strong>No rows.</strong>
              <span>This dataset has no rows in the current read window.</span>
            </div>
          ) : (
            <div className="table-wrap">
              <TableControls {...rowControls.controlsProps} searchPlaceholder="Search visible rows by ID, domain, model, status, summary..." />
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="expander-col" aria-label="Details" />
                    {visibleColumns.map((column) => (
                      <th key={column.name} {...rowControls.sortHeaderProps(column.name)}>
                        {column.name}
                        <span className="sortable-th-arrow">
                          {rowControls.sort.key === column.name ? (rowControls.sort.dir === "asc" ? "▲" : "▼") : "⇅"}
                        </span>
                        {column.redacted && <span className="pill amber" style={{ marginLeft: 6 }}>redacted</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rowControls.rows.map((row, index) => {
                    const key = rowControls.getRowKey(row, index);
                    const expanded = rowControls.isExpanded(key);
                    return (
                    <Fragment key={key}>
                    <tr key={key} className="data-row-clickable" onClick={() => rowControls.toggleExpanded(key)}>
                      <td className="expander-col">
                        <button
                          type="button"
                          className="table-expander"
                          aria-label={expanded ? "Collapse row detail" : "Expand row detail"}
                          aria-expanded={expanded}
                          onClick={(event) => {
                            event.stopPropagation();
                            rowControls.toggleExpanded(key);
                          }}
                        >
                          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                      {visibleColumns.map((column) => (
                        <td key={column.name} className={columnClass(column.name)} title={displayValue(row[column.name])}>
                          {truncate(displayValue(row[column.name]))}
                        </td>
                      ))}
                    </tr>
                    {expanded && (
                      <tr key={`${key}:detail`} className="data-row-detail">
                        <td colSpan={visibleColumns.length + 1}>
                          <div className="data-row-detail-inner">
                            <div className="data-row-detail-grid">
                              {columns.map((column) => (
                                <div key={column.name}>
                                  <span>{column.name}</span>
                                  <strong>{displayValue(row[column.name]) || "—"}</strong>
                                </div>
                              ))}
                            </div>
                            <div className="evidence-block">
                              <div className="evidence-block-title">Raw row</div>
                              <pre className="audit-pre detail-json">{JSON.stringify(row, null, 2)}</pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
