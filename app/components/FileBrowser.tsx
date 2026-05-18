import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useApi } from "../hooks/useApi";

type FsEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: number;
};

type FsBrowseResponse = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
};

export function FileBrowser({
  value,
  onChange,
  filter = "",
  type = "",
  placeholder = "Select a file...",
  rootPath = "/opt/",
}: {
  value: string;
  onChange: (path: string) => void;
  filter?: string;
  type?: "file" | "directory" | "";
  placeholder?: string;
  rootPath?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const containerRef = useRef<HTMLDivElement>(null);
  const { data, loading, error } = useApi<FsBrowseResponse>(
    `/api/fs/browse?path=${encodeURIComponent(currentPath)}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}${type ? `&type=${type}` : ""}`,
    isOpen ? 5000 : 0 // Poll when open
  );

  const filteredEntries = useMemo(() => {
    if (!data?.entries) return [];
    
    // Filter by type if specified
    let entries = data.entries;
    if (type) {
      entries = entries.filter(entry => entry.type === type);
    }
    
    // Sort: directories first, then alphabetically
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [data, type]);

  useEffect(() => {
    if (!isOpen) return;
    
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  function handleEntryClick(entry: FsEntry) {
    if (entry.type === "directory") {
      setCurrentPath(entry.path);
    } else {
      onChange(entry.path);
      setIsOpen(false);
    }
  }

  function handleParentClick() {
    if (data?.parent) {
      setCurrentPath(data.parent);
    }
  }

  return (
    <div className="file-browser" ref={containerRef}>
      <button
        type="button"
        className="file-browser-trigger"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="file-browser-value">
          {value || placeholder}
        </span>
        <ChevronDown size={14} className={isOpen ? "rotated" : ""} />
      </button>

      {isOpen && (
        <div className="file-browser-dropdown">
          <div className="file-browser-header">
            <button
              type="button"
              className="file-browser-nav-btn"
              onClick={handleParentClick}
              disabled={!data?.parent || currentPath === rootPath}
            >
              ⬆️ Up
            </button>
            <div className="file-browser-path" title={currentPath}>
              {currentPath}
            </div>
          </div>
          
          <div className="file-browser-content">
            {loading && !data && (
              <div className="file-browser-loading">Loading...</div>
            )}
            
            {error && !data && (
              <div className="file-browser-error">Error: {error}</div>
            )}
            
            {data && (
              <div className="file-browser-entries">
                {filteredEntries.length === 0 ? (
                  <div className="file-browser-empty">No items found</div>
                ) : (
                  filteredEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className={`file-browser-entry ${entry.type} ${value === entry.path ? "selected" : ""}`}
                      onClick={() => handleEntryClick(entry)}
                    >
                      {entry.type === "directory" ? (
                        <Folder size={16} />
                      ) : (
                        <File size={16} />
                      )}
                      <span className="file-browser-entry-name">{entry.name}</span>
                      {entry.type === "file" && entry.size !== undefined && (
                        <span className="file-browser-entry-size">
                          {formatFileSize(entry.size)}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}