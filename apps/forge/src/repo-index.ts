import { DurableObject } from "cloudflare:workers";

// Which project, and which agent, each repository belongs to. A push event
// names only the repository, so the event handler looks it up here.

export interface RepoEntry {
  projectId: string;
  /** The agent whose fork this is, or null for the project repository. */
  agentId: string | null;
}

export class RepoIndex extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT)");
  }

  put(name: string, entry: RepoEntry): void {
    this.sql.exec("INSERT OR REPLACE INTO repos (name, project_id, agent_id) VALUES (?, ?, ?)", name, entry.projectId, entry.agentId);
  }

  get(name: string): RepoEntry | null {
    const row = this.sql
      .exec<{ project_id: string; agent_id: string | null }>("SELECT project_id, agent_id FROM repos WHERE name = ?", name)
      .toArray()[0];
    return row ? { projectId: row.project_id, agentId: row.agent_id } : null;
  }

  removeProject(projectId: string): void {
    this.sql.exec("DELETE FROM repos WHERE project_id = ?", projectId);
  }
}

/** The one repo index. */
export function repoIndex(env: Env) {
  return env.REPO_INDEX.get(env.REPO_INDEX.idFromName("global"));
}
