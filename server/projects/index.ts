export type { Project } from "./types.ts";
export type { DetectedProject } from "./detector.ts";
export { upsertProject, getProject, listProjects, deleteProject } from "./store.ts";
export { detectProject } from "./detector.ts";
