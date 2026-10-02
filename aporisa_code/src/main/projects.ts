// Projects (F4.5, DEVELOPMENT_PLAN.md 10.9): account-level, in
// <dataDir>/profiles/local/projects.json (versioned, like preferences.json). A project is a
// name, one main folder (the working directory of its chats) and any number of reference
// folders. Projects are the app's grouping only: the harness sees a cwd and reference
// directories, and each chat records its project id (SessionMeta.projectId).
// Paths are validated by the app server before they get here.
import { join } from "node:path";
import { z } from "zod";
import { profileDir } from "../harness/index.ts";
import { readJson, writePrivateJson } from "./settings.ts";

const Project = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  main: z.string().min(1),
  references: z.array(z.string()).catch([]),
  createdAt: z.string(),
});

const ProjectsFile = z.object({
  version: z.literal(1),
  // An invalid entry is dropped, not the whole list.
  projects: z.array(z.unknown()).transform((entries) => entries.flatMap((entry) => {
    const parsed = Project.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  })),
});

export type Project = z.infer<typeof Project>;

export class ProjectStore {
  readonly path: string;
  private projects: Project[] = [];

  constructor(dataDir: string) {
    this.path = join(profileDir(dataDir), "projects.json");
  }

  async load(): Promise<void> {
    this.projects = (await readJson(this.path, ProjectsFile, { version: 1 as const, projects: [] })).projects;
  }

  list(): Project[] {
    return this.projects.map((project) => ({ ...project, references: [...project.references] }));
  }

  get(id: string): Project | null {
    return this.list().find((project) => project.id === id) ?? null;
  }

  /** The project whose main folder is `path`. */
  byMain(path: string): Project | null {
    return this.list().find((project) => project.main === path) ?? null;
  }

  /** Adds a project for a main folder, or returns the one that already has it. */
  async create(main: string, name: string, now: Date): Promise<Project> {
    const existing = this.byMain(main);
    if (existing) return existing;
    const project: Project = { id: crypto.randomUUID(), name, main, references: [], createdAt: now.toISOString() };
    this.projects.push(project);
    await this.save();
    return { ...project, references: [] };
  }

  async update(id: string, change: { name?: string; references?: string[] }): Promise<Project> {
    const project = this.projects.find((entry) => entry.id === id);
    if (!project) throw new Error(`no project ${id}`);
    if (change.name !== undefined) project.name = change.name;
    if (change.references !== undefined) project.references = [...change.references];
    await this.save();
    return { ...project, references: [...project.references] };
  }

  /** Removes the entry only: folders on disk and chats are untouched. */
  async remove(id: string): Promise<boolean> {
    const before = this.projects.length;
    this.projects = this.projects.filter((project) => project.id !== id);
    if (this.projects.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await writePrivateJson(this.path, { version: 1, projects: this.projects });
  }
}
