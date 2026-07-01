import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { TableControlsPropsFromHook } from "../hooks/useTableControls";

interface TableControlsProps extends TableControlsPropsFromHook {
  searchPlaceholder?: string;
  className?: string;
}

export function TableControls({
  query,
  onQueryChange,
  totalRows,
  filteredRows,
  page,
  pageCount,
  pageSize,
  pageSizeOptions,
  setPageSize,
  startRow,
  endRow,
  canPreviousPage,
  canNextPage,
  previousPage,
  nextPage,
  searchPlaceholder = "Filter rows...",
  className = "",
}: TableControlsProps) {
  const filtered = filteredRows !== totalRows;

  return (
    <div className={`table-controls ${className}`.trim()}>
      <label className="table-controls-search">
        <Search size={14} strokeWidth={1.8} aria-hidden="true" />
        <input
          className="filter-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchPlaceholder}
          type="search"
        />
      </label>

      <div className="table-controls-meta">
        <span className="table-count-badge" title={`${pageSize} rows per page`}>
          {startRow}-{endRow} of {filteredRows}
        </span>
        {filtered && (
          <span className="table-count-badge muted">
            {totalRows} total
          </span>
        )}
        <label className="table-page-size">
          <span>Rows</span>
          <select
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-controls-pagination" aria-label="Table pagination">
        <button
          className="btn btn-sm btn-ghost table-page-btn"
          type="button"
          onClick={previousPage}
          disabled={!canPreviousPage}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <span className="table-page-status">
          {page} / {pageCount}
        </span>
        <button
          className="btn btn-sm btn-ghost table-page-btn"
          type="button"
          onClick={nextPage}
          disabled={!canNextPage}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
