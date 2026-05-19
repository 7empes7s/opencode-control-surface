import { useCallback, useEffect, useMemo, useState } from "react";

export type TableSortDir = "asc" | "desc";
export type TableSortValue = string | number | boolean | Date | null | undefined;

export interface TableSortState<K extends string> {
  key: K | null;
  dir: TableSortDir;
}

export interface TableControlsPropsFromHook {
  query: string;
  onQueryChange: (query: string) => void;
  totalRows: number;
  filteredRows: number;
  page: number;
  pageCount: number;
  pageSize: number;
  startRow: number;
  endRow: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  previousPage: () => void;
  nextPage: () => void;
  goToPage: (page: number) => void;
}

interface UseTableControlsOptions<T, K extends string> {
  rows: T[];
  pageSize?: number;
  defaultSort?: TableSortState<K>;
  filter?: (row: T, query: string) => boolean;
  filterText?: (row: T) => TableSortValue | TableSortValue[];
  sortValue?: (row: T, key: K) => TableSortValue;
  tieBreak?: K[];
}

function compareValues(a: TableSortValue, b: TableSortValue, dir: TableSortDir): number {
  const aNull = a === null || a === undefined || a === "";
  const bNull = b === null || b === undefined || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  const aValue = a instanceof Date ? a.getTime() : a;
  const bValue = b instanceof Date ? b.getTime() : b;
  let cmp = 0;

  if (typeof aValue === "number" && typeof bValue === "number") {
    cmp = aValue - bValue;
  } else if (typeof aValue === "boolean" && typeof bValue === "boolean") {
    cmp = aValue === bValue ? 0 : aValue ? -1 : 1;
  } else {
    cmp = String(aValue).localeCompare(String(bValue), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  return dir === "asc" ? cmp : -cmp;
}

function defaultFilter<T>(row: T, query: string, filterText?: (row: T) => TableSortValue | TableSortValue[]) {
  const values = filterText ? filterText(row) : JSON.stringify(row);
  const haystack = (Array.isArray(values) ? values : [values])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join(" ");

  return haystack.includes(query);
}

export function useTableControls<T, K extends string>({
  rows,
  pageSize = 25,
  defaultSort = { key: null, dir: "asc" },
  filter,
  filterText,
  sortValue,
  tieBreak = [],
}: UseTableControlsOptions<T, K>) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TableSortState<K>>(defaultSort);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredRows = useMemo(() => {
    if (!normalizedQuery) return rows;
    return rows.filter((row) =>
      filter ? filter(row, normalizedQuery) : defaultFilter(row, normalizedQuery, filterText),
    );
  }, [filter, filterText, normalizedQuery, rows]);

  const sortedRows = useMemo(() => {
    if (!sort.key || !sortValue) return filteredRows;
    const key = sort.key;
    const dir = sort.dir;

    return [...filteredRows].sort((a, b) => {
      const primary = compareValues(sortValue(a, key), sortValue(b, key), dir);
      if (primary !== 0) return primary;
      for (const tieKey of tieBreak) {
        const tied = compareValues(sortValue(a, tieKey), sortValue(b, tieKey), "asc");
        if (tied !== 0) return tied;
      }
      return 0;
    });
  }, [filteredRows, sort, sortValue, tieBreak]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedRows = sortedRows.slice(startIndex, startIndex + pageSize);
  const startRow = sortedRows.length === 0 ? 0 : startIndex + 1;
  const endRow = Math.min(startIndex + pageSize, sortedRows.length);

  useEffect(() => {
    setPage(1);
  }, [normalizedQuery, sort.key, sort.dir, pageSize]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const goToPage = useCallback((nextPage: number) => {
    setPage(Math.max(1, Math.min(nextPage, pageCount)));
  }, [pageCount]);

  const nextPage = useCallback(() => {
    setPage((current) => Math.min(current + 1, pageCount));
  }, [pageCount]);

  const previousPage = useCallback(() => {
    setPage((current) => Math.max(current - 1, 1));
  }, []);

  const onSort = useCallback((key: K) => {
    setSort((current) => {
      if (current.key !== key) return { key, dir: "asc" };
      if (current.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: "asc" };
    });
  }, []);

  const sortHeaderProps = useCallback((key: K) => ({
    className: `sortable-th${sort.key === key ? " sortable-th-active" : ""}`,
    onClick: () => onSort(key),
    "aria-sort": sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none",
  } as const), [onSort, sort]);

  const controlsProps: TableControlsPropsFromHook = {
    query,
    onQueryChange: setQuery,
    totalRows: rows.length,
    filteredRows: filteredRows.length,
    page: safePage,
    pageCount,
    pageSize,
    startRow,
    endRow,
    canPreviousPage: safePage > 1,
    canNextPage: safePage < pageCount,
    previousPage,
    nextPage,
    goToPage,
  };

  return {
    rows: paginatedRows,
    filteredRows,
    sortedRows,
    query,
    setQuery,
    sort,
    setSort,
    onSort,
    sortHeaderProps,
    page: safePage,
    pageCount,
    pageSize,
    totalRows: rows.length,
    filteredCount: filteredRows.length,
    startRow,
    endRow,
    canPreviousPage: controlsProps.canPreviousPage,
    canNextPage: controlsProps.canNextPage,
    previousPage,
    nextPage,
    goToPage,
    controlsProps,
  };
}
