import type { DossierClaim } from "../../server/api/types";

interface ClaimsTableProps {
  claims: DossierClaim[];
}

export function ClaimsTable({ claims }: ClaimsTableProps) {
  if (claims.length === 0) {
    return <div className="loading-dim">No claims found</div>;
  }
  
  // Helper function to get confidence color
  const getConfidenceColor = (confidence: string) => {
    if (confidence.toLowerCase().includes("high")) return "green";
    if (confidence.toLowerCase().includes("medium")) return "amber";
    if (confidence.toLowerCase().includes("low")) return "red";
    return "gray";
  };
  
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Claim</th>
            <th>Sources</th>
            <th>Evidence Quality</th>
            <th>Confidence</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim, index) => (
            <tr key={index}>
              <td>{claim.claim}</td>
              <td>{claim.sources}</td>
              <td>{claim.evidenceQuality}</td>
              <td>
                <span className={`pill ${getConfidenceColor(claim.confidence)}`}>
                  {claim.confidence}
                </span>
              </td>
              <td>{claim.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}