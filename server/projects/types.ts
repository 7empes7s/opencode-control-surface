export type Project = {
  id: string;
  tenantId: string;
  name: string;
  repoPath: string;
  language: string;
  framework: string;
  validatorCommands: string[];
  defaultModelRoster: string[];
  defaultPolicies: object;
  status: string;
  createdAt: number;
  updatedAt: number;
};
