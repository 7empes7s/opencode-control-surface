import { useMemo, useState, useCallback } from "react";

export type SortDir = "asc" | "desc";

export interface SortState<K extends string> {
  key: K | null;
  dir: SortDir;
}

export type SortValue = string | number | boolean | null | undefined;

export type Accessor<T, K extends string> = (row: T, key: K) => SortValue;

interface UseTableSortOptions<T, K extends string> {
  defaultKey?: K | null;
  defaultDir?: SortDir;
  tieBreak?: K[];
  accessor: Accessor<T, K>;
}

function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const aNull = a === null || a === undefined || a === "";
  const bNull = b === null || b === undefined || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  let cmp = 0;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a - b;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    cmp = a === b ? 0 : a ? -1 : 1;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }
  return dir === "asc" ? cmp : -cmp;
}

export function useTableSort<T, K extends string>(
  rows: T[],
  options: UseTableSortOptions<T, K>,
) {
  const { defaultKey = null, defaultDir = "asc", tieBreak = [], accessor } = options;
  const [sort, setSort] = useState<SortState<K>>({ key: defaultKey, dir: defaultDir });

  const onSort = useCallback((key: K) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: "asc" };
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const key = sort.key;
    const dir = sort.dir;
    return [...rows].sort((a, b) => {
      const primary = compareValues(accessor(a, key), accessor(b, key), dir);
      if (primary !== 0) return primary;
      for (const tk of tieBreak) {
        const t = compareValues(accessor(a, tk), accessor(b, tk), "asc");
        if (t !== 0) return t;
      }
      return 0;
    });
  }, [rows, sort, accessor, tieBreak]);

  return { sorted, sort, onSort };
}
