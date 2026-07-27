export type Iso42001AnnexAReferenceClause = {
  id: string;
  title: string;
};

// Static reference index only. Short titles identify Annex A clauses; this is
// not a Statement of Applicability or a certification claim.
export const ISO_42001_ANNEX_A_REFERENCE_INDEX: readonly Iso42001AnnexAReferenceClause[] = [
  { id: "A.2.1", title: "Objective" },
  { id: "A.2.2", title: "AI policy" },
  { id: "A.2.3", title: "Alignment with other organizational policies" },
  { id: "A.2.4", title: "Review of AI policy" },
  { id: "A.3.1", title: "Objective" },
  { id: "A.3.2", title: "AI roles and responsibilities" },
  { id: "A.3.3", title: "Reporting of concerns" },
  { id: "A.4.1", title: "Objective" },
  { id: "A.4.2", title: "Resource documentation" },
  { id: "A.4.3", title: "Data resources" },
  { id: "A.4.4", title: "Tooling resources" },
  { id: "A.4.5", title: "System and computing resources" },
  { id: "A.4.6", title: "Human resources" },
  { id: "A.5.1", title: "Objective" },
  { id: "A.5.2", title: "AI system impact assessment process" },
  { id: "A.5.3", title: "Impact assessment documentation" },
  { id: "A.5.4", title: "Impact on individuals or groups" },
  { id: "A.5.5", title: "Societal impacts" },
  { id: "A.6.1", title: "Management direction for AI development" },
  { id: "A.6.1.1", title: "Objective" },
  { id: "A.6.1.2", title: "Objectives for responsible development" },
  { id: "A.6.1.3", title: "Responsible design and development processes" },
  { id: "A.6.2", title: "AI system life cycle" },
  { id: "A.6.2.1", title: "Objective" },
  { id: "A.6.2.2", title: "AI system requirements and specification" },
  { id: "A.6.2.3", title: "Design and development documentation" },
  { id: "A.6.2.4", title: "AI system verification and validation" },
  { id: "A.6.2.5", title: "AI system deployment" },
  { id: "A.6.2.6", title: "AI system operation and monitoring" },
  { id: "A.6.2.7", title: "AI system technical documentation" },
  { id: "A.6.2.8", title: "AI system event logging" },
  { id: "A.7.1", title: "Objective" },
  { id: "A.7.2", title: "Data for development and enhancement" },
  { id: "A.7.3", title: "Data acquisition" },
  { id: "A.7.4", title: "Data quality" },
  { id: "A.7.5", title: "Data provenance" },
  { id: "A.7.6", title: "Data preparation" },
  { id: "A.8.1", title: "Objective" },
  { id: "A.8.2", title: "System documentation and user information" },
  { id: "A.8.3", title: "External reporting" },
  { id: "A.8.4", title: "Incident communication" },
  { id: "A.8.5", title: "Information for interested parties" },
  { id: "A.9.1", title: "Objective" },
  { id: "A.9.2", title: "Responsible-use processes" },
  { id: "A.9.3", title: "Responsible-use objectives" },
  { id: "A.9.4", title: "Intended use" },
  { id: "A.10.1", title: "Objective" },
  { id: "A.10.2", title: "Responsibility allocation" },
  { id: "A.10.3", title: "Suppliers" },
  { id: "A.10.4", title: "Customers" },
];

export const ISO_42001_ANNEX_A_REFERENCE_BY_ID = new Map(
  ISO_42001_ANNEX_A_REFERENCE_INDEX.map((clause) => [clause.id, clause]),
);
