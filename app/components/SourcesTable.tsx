import type { DossierSource } from "../../server/api/types";

interface SourcesTableProps {
  sources: DossierSource[];
}

export function SourcesTable({ sources }: SourcesTableProps) {
  if (sources.length === 0) {
    return <div className="loading-dim">No sources found</div>;
  }
  
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>URL</th>
            <th>Type</th>
            <th>Publisher</th>
            <th>Date</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source, index) => (
            <tr key={index}>
              <td className="mono trunc">
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.url}
                </a>
              </td>
              <td>{source.type}</td>
              <td>{source.publisher}</td>
              <td>{source.date}</td>
              <td>{source.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}