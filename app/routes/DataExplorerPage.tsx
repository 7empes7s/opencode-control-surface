import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Database, RefreshCw } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { TableControls } from "../components/TableControls";
import { Reveal } from "../components/v5/ui";
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
      <Reveal>
        <header className="v5-pagehead">
          <div className="v5-pagehead-row">
            <div>
              <div className="v5-pagehead-title">Data Explorer</div>
              <p className="v5-pagehead-sub">Advanced, read-only inspection of the dashboard database — pick a dataset, then search and sort its rows.</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="v5-pill warn">experimental</span>
              <button
                type="button"
                className="v5-btn"
                onClick={() => {
                  tables.refresh();
                  rows.refresh();
                }}
              >
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>
          </div>
        </header>
      </Reveal>

      <Reveal delay={0.04}>
        <section className="data-explorer-grid" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <aside className="v5-card flat-hover" style={{ display: "grid", gap: 8, alignContent: "start", padding: 12, flex: "0 1 230px", minWidth: 180 }}>
            <div className="v5-card-label">Datasets</div>
            {tables.loading && !tables.data ? (
              <div style={{ display: "grid", gap: 8 }}>
                {[0, 1, 2, 3].map((i) => <div key={i} className="v5-skeleton" style={{ height: 40 }} />)}
              </div>
            ) : tables.error && !tables.data ? (
              <div style={{ fontSize: 13, color: "var(--red)" }}>error: {tables.error}</div>
            ) : tableList.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
                No datasets available — the dashboard database is disabled or empty.
              </p>
            ) : (
              tableList.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  className={`v5-btn${selectedTable === table.name ? " primary" : " ghost"}`}
                  onClick={() => chooseTable(table.name)}
                  style={{ justifyContent: "space-between", width: "100%" }}
                >
                  <span>{table.label}</span>
                  <span className="mono" style={{ opacity: 0.75, fontSize: 11 }}>{table.rowCount}</span>
                </button>
              ))
            )}
          </aside>

          <div style={{ minWidth: 0, flex: "1 1 340px", display: "grid", gap: 12, alignContent: "start" }}>
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap", alignItems: "flex-start" }}>
              <div>
                <div className="v5-card-label">{selectedInfo?.name ?? selectedTable}</div>
                <strong style={{ fontFamily: "var(--display)", fontSize: 17, color: "var(--text-bright)" }}>{selectedInfo?.label ?? selectedTable}</strong>
                {selectedInfo?.description && <div style={{ marginTop: 4, fontSize: 13, color: "var(--text-muted)" }}>{selectedInfo.description}</div>}
              </div>
              {total > limit && (
                <span className="v5-pill warn" title="The read-only endpoint safely caps each explorer read.">
                  first {limit} of {total}
                </span>
              )}
            </div>

            {rows.loading && !rows.data ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="v5-skeleton" style={{ height: 16, width: "35%" }} />
                <div className="v5-skeleton" style={{ height: 240 }} />
              </div>
            ) : rows.error && !rows.data ? (
              <div className="v5-card flat-hover" style={{ fontSize: 13, color: "var(--red)" }}>error: {rows.error}</div>
            ) : rows.data?.rows.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                This dataset has no rows in the current read window.
              </p>
            ) : (
              <>
                <div className="v5-card flat-hover" style={{ padding: "8px 12px" }}>
                  <TableControls {...rowControls.controlsProps} searchPlaceholder="Search visible rows by ID, domain, model, status, summary..." />
                </div>
                <div className="v5-table-wrap">
                  <table className="v5-table responsive">
                    <thead>
                      <tr>
                        <th className="expander-col" aria-label="Details" />
                        {visibleColumns.map((column) => (
                          <th key={column.name} {...rowControls.sortHeaderProps(column.name)}>
                            {column.name}
                            <span className="sortable-th-arrow">
                              {rowControls.sort.key === column.name ? (rowControls.sort.dir === "asc" ? "▲" : "▼") : "⇅"}
                            </span>
                            {column.redacted && <span className="v5-pill warn" style={{ marginLeft: 6 }}>redacted</span>}
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
                          <td className="expander-col" data-no-label>
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
                            <td key={column.name} data-label={column.name} className={columnClass(column.name)} title={displayValue(row[column.name])}>
                              {truncate(displayValue(row[column.name]))}
                            </td>
                          ))}
                        </tr>
                        {expanded && (
                          <tr key={`${key}:detail`} className="data-row-detail">
                            <td colSpan={visibleColumns.length + 1} data-no-label>
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
              </>
            )}
          </div>
        </section>
      </Reveal>
    </div>
  );
}
