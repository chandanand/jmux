// src/adapters/linear.ts
import { HttpError, type IssueTrackerAdapter, type AdapterAuthState, type AdapterIdentity, type Issue, type IssueStateType, type WorkflowState } from "./types";
import { buildLinearPrompt, buildLinearGroupPrompt } from "./linear-prompt";
import { logError } from "../log";
import { openUrl } from "../platform";
import { resolveCredential } from "../credentials";

const LINEAR_API = "https://api.linear.app/graphql";

// Shared GraphQL fields for issue queries
const ISSUE_FIELDS = `id identifier title description branchName state { name type } assignee { name } team { name } project { name } priority updatedAt labels { nodes { name parent { name } } } attachments { nodes { title url sourceType } } comments(first: 20) { nodes { id parent { id } body user { name } createdAt } } url`;

const ISSUE_STATE_TYPES: ReadonlySet<IssueStateType> = new Set(["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"]);
function isIssueStateType(v: unknown): v is IssueStateType {
  return typeof v === "string" && ISSUE_STATE_TYPES.has(v as IssueStateType);
}

export function extractIssueIdFromBranch(branch: string): string | null {
  const match = branch.match(/(?:^|\/?)([a-zA-Z]+-\d+)/);
  if (!match) return null;
  return match[1].toUpperCase();
}

export class LinearAdapter implements IssueTrackerAdapter {
  type = "linear";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$LINEAR_API_KEY or $LINEAR_TOKEN";
  identity: AdapterIdentity | null = null;
  private token: string | null = null;

  constructor(_config: Record<string, unknown>) {}

  async authenticate(): Promise<void> {
    // Through the shared resolver, never process.env directly: `jmux ctl`
    // constructs its own adapters, so a token stored by the wizard would
    // otherwise work in the TUI and fail in the CLI.
    const { token } = resolveCredential("linear", ["LINEAR_API_KEY", "LINEAR_TOKEN"]);
    if (!token) { this.authState = "failed"; this.identity = null; return; }
    this.token = token;
    // A real request, not merely a non-empty string. Presence proved nothing:
    // a revoked, malformed or wrong-workspace token reported `ok`, so every
    // "connected" the UI showed was a claim about a string existing. It also
    // makes "swap only on success" mean something — see swapAdapters.
    try {
      const resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query: `query { viewer { id name organization { name urlKey } } }` }),
      });
      if (!resp.ok) { this.authState = "failed"; this.identity = null; return; }
      const json = await resp.json() as {
        data?: { viewer?: { id?: string; name?: string; organization?: { name?: string } } };
      };
      const viewer = json?.data?.viewer;
      if (!viewer?.id) { this.authState = "failed"; this.identity = null; return; }
      this.identity = {
        account: viewer.name ?? viewer.id,
        organization: viewer.organization?.name ?? null,
      };
      this.authState = "ok";
    } catch {
      // Network, DNS, timeout — the token may be perfectly good. Latching
      // `failed` here would block a swap over a blip.
      this.authState = "unreachable";
      this.identity = null;
    }
  }

  async getLinkedIssue(mrUrl: string): Promise<Issue | null> {
    const query = `query($url: String!) { attachments(filter: { url: { eq: $url } }, first: 1) { nodes { issue { ${ISSUE_FIELDS} } } } }`;
    const resp = await this.graphql(query, { url: mrUrl });
    if (!resp) return null;
    const nodes = resp.data?.attachments?.nodes;
    if (!nodes || nodes.length === 0) return null;
    return this.mapIssue(nodes[0].issue);
  }

  async getIssueByBranch(branch: string): Promise<Issue | null> {
    const identifier = extractIssueIdFromBranch(branch);
    if (!identifier) return null;
    // Search rather than `issue(id: $identifier)`: a direct lookup answers an
    // unknown identifier with "Entity not found" and no data, and most branches
    // legitimately carry no issue at all. Search returns loose matches instead,
    // which the identifier check below rejects — no error path for the common case.
    const query = `query($identifier: String!) { searchIssues(term: $identifier, first: 1) { nodes { ${ISSUE_FIELDS} } } }`;
    const resp = await this.graphql(query, { identifier });
    if (!resp) return null;
    const nodes = resp.data?.searchIssues?.nodes;
    if (!nodes || nodes.length === 0) return null;
    const issue = nodes[0];
    if (issue.identifier?.toUpperCase() !== identifier) return null;
    return this.mapIssue(issue);
  }

  async pollIssue(issueId: string): Promise<Issue> {
    const query = `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
    const resp = await this.graphql(query, { id: issueId });
    if (!resp?.data?.issue) {
      throw new HttpError("Issue not found", 404);
    }
    return this.mapIssue(resp.data.issue);
  }

  async pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>> {
    const result = new Map<string, Issue>();
    if (issueIds.length === 0) return result;
    const varDefs = issueIds.map((_, i) => `$id${i}: String!`).join(", ");
    const fragments = issueIds.map(
      (_, i) =>
        `issue${i}: issue(id: $id${i}) { ${ISSUE_FIELDS} }`
    );
    const variables: Record<string, unknown> = {};
    issueIds.forEach((id, i) => { variables[`id${i}`] = id; });
    const query = `query(${varDefs}) { ${fragments.join("\n")} }`;
    const resp = await this.graphql(query, variables);
    if (!resp?.data) return result;
    for (let i = 0; i < issueIds.length; i++) {
      const raw = resp.data[`issue${i}`];
      if (raw) result.set(issueIds[i], this.mapIssue(raw));
    }
    return result;
  }

  async getAvailableStatuses(issueId: string): Promise<string[]> {
    const query = `query($id: String!) { issue(id: $id) { team { states { nodes { name position } } } } }`;
    const resp = await this.graphql(query, { id: issueId });
    if (!resp?.data?.issue?.team?.states?.nodes) return [];
    const states = resp.data.issue.team.states.nodes as Array<{ name: string; position: number }>;
    return states.sort((a, b) => a.position - b.position).map((s) => s.name);
  }

  openInBrowser(issueId: string): void {
    this.graphql(`query($id: String!) { issue(id: $id) { url } }`, { id: issueId }).then((resp) => {
      const url = resp?.data?.issue?.url;
      if (url) openUrl(url);
    });
  }

  async searchIssues(query: string): Promise<Issue[]> {
    if (this.authState !== "ok") return [];
    const gql = `
      query($query: String!) {
        searchIssues(term: $query, first: 20) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;
    const resp = await this.graphql(gql, { query });
    if (!resp?.data?.searchIssues?.nodes) return [];
    return resp.data.searchIssues.nodes.map((n: any) => this.mapIssue(n));
  }

  async getMyIssues(): Promise<Issue[]> {
    if (this.authState !== "ok") return [];
    const query = `
      query {
        viewer {
          assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      }
    `;
    const resp = await this.graphql(query, {});
    if (!resp?.data?.viewer?.assignedIssues?.nodes) return [];
    return resp.data.viewer.assignedIssues.nodes.map((n: any) => this.mapIssue(n));
  }

  async listWorkflowStates(): Promise<WorkflowState[]> {
    if (this.authState !== "ok") return [];
    const query = `query { teams { nodes { name states { nodes { id name type position } } } } }`;
    const resp = await this.graphql(query, {});
    return mapWorkflowStates(resp?.data);
  }

  async getTeams(): Promise<Array<{ id: string; name: string }>> {
    if (this.authState !== "ok") return [];
    const query = `query { teams { nodes { id name } } }`;
    const resp = await this.graphql(query, {});
    if (!resp?.data?.teams?.nodes) return [];
    return resp.data.teams.nodes.map((t: any) => ({ id: t.id ?? "", name: t.name ?? "" }));
  }

  async updateStatus(issueId: string, status: string): Promise<void> {
    const statesQuery = `query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`;
    const statesResp = await this.graphql(statesQuery, { id: issueId });
    const states = statesResp?.data?.issue?.team?.states?.nodes as
      | Array<{ id: string; name: string }>
      | undefined;
    if (!states) return;
    const targetState = states.find((s) => s.name === status);
    if (!targetState) return;
    const mutation = `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;
    await this.graphql(mutation, { id: issueId, stateId: targetState.id });
  }

  async createIssue(teamId: string, title: string, description: string): Promise<Issue> {
    const mutation = `
      mutation($teamId: String!, $title: String!, $description: String!) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }
    `;
    const resp = await this.graphql(mutation, { teamId, title, description });
    if (!resp?.data?.issueCreate?.success || !resp?.data?.issueCreate?.issue) {
      throw new Error("Failed to create issue");
    }
    return this.mapIssue(resp.data.issueCreate.issue);
  }

  buildPrompt(issue: Issue): string {
    return buildLinearPrompt(issue);
  }

  buildGroupPrompt(issues: Issue[], label: string): string {
    return buildLinearGroupPrompt(issues, label);
  }

  private mapIssue(raw: any): Issue {
    return {
      id: raw.id ?? "",
      identifier: raw.identifier ?? "",
      title: raw.title ?? "",
      status: raw.state?.name ?? "Unknown",
      stateType: isIssueStateType(raw.state?.type) ? raw.state.type : undefined,
      assignee: raw.assignee?.name ?? null,
      linkedMrUrls: (raw.attachments?.nodes ?? [])
        .map((a: any) => a.url)
        .filter((u: string) => u && (u.includes("merge_requests") || u.includes("/pull/"))),
      webUrl: raw.url ?? "",
      team: raw.team?.name ?? undefined,
      project: raw.project?.name ?? undefined,
      priority: typeof raw.priority === "number" ? raw.priority : undefined,
      updatedAt: raw.updatedAt ? new Date(raw.updatedAt).getTime() : undefined,
      description: raw.description ?? undefined,
      branchName: raw.branchName ?? undefined,
      labels: (raw.labels?.nodes ?? [])
        .filter((l: any) => l?.name)
        .map((l: any) => ({
          name: l.name as string,
          ...(l.parent?.name ? { group: l.parent.name as string } : {}),
        })),
      comments: (raw.comments?.nodes ?? []).map((c: any) => ({
        id: c.id ?? undefined,
        parentId: c.parent?.id ?? undefined,
        author: c.user?.name ?? "Unknown",
        body: c.body ?? "",
        createdAt: c.createdAt ?? "",
      })),
      links: (raw.attachments?.nodes ?? [])
        .filter((a: any) => a.url)
        .map((a: any) => ({
          type: a.sourceType ?? "",
          title: a.title ?? undefined,
          url: a.url,
        })),
    };
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>
  ): Promise<any | null> {
    try {
      const resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.token ?? "",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) this.authState = "failed";
        throw new HttpError(`Linear API error: ${resp.status}`, resp.status);
      }
      const body = await resp.json();

      // A GraphQL error arrives as HTTP 200 with an `errors` array, so the
      // status check above cannot see it. Returning the body regardless is how
      // a *deprecated field* came to look exactly like "no results": every
      // branch-derived issue silently vanished from the sidebar with nothing
      // logged. Surfacing it means the next deprecation announces itself.
      const errors = body?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const message = errors.map((e: any) => e?.message ?? "unknown").join("; ");
        if (body.data == null) {
          const notFound = errors.some((e: any) => /entity not found/i.test(e?.message ?? ""));
          throw new HttpError(`Linear GraphQL error: ${message}`, notFound ? 404 : 400);
        }
        // Partial data — one alias of a batched query failed (a stale link,
        // say). Keep the rows that did resolve rather than losing the batch.
        logError("Linear", `partial GraphQL error: ${message}`);
      }
      return body;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      logError("Linear", `request failed: ${(e as Error).message}`);
      return null;
    }
  }
}

/**
 * Flatten Linear's per-team workflow states into one global, position-ordered
 * list, de-duplicated by name.
 *
 * De-duplication by *name* rather than id is deliberate and matches how stage
 * mapping is configured: a workspace that calls the same step "QA" on every
 * team should produce one picker row and one mapping entry, not one per team.
 * Teams that genuinely diverge simply contribute their own extra names.
 */
export function mapWorkflowStates(data: unknown): WorkflowState[] {
  const teams = (data as any)?.teams?.nodes;
  if (!Array.isArray(teams)) return [];

  const rows: Array<{ state: WorkflowState; position: number }> = [];
  const seen = new Set<string>();
  for (const team of teams) {
    const nodes = team?.states?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      const name = typeof n?.name === "string" ? n.name : "";
      if (!name) continue;
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        state: {
          id: typeof n.id === "string" ? n.id : "",
          name,
          type: (n.type ?? "unstarted") as IssueStateType,
          team: typeof team?.name === "string" ? team.name : undefined,
        },
        position: typeof n.position === "number" ? n.position : 0,
      });
    }
  }
  return rows.sort((a, b) => a.position - b.position).map((r) => r.state);
}
