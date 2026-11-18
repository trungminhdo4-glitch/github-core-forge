// Model Context Protocol at /mcp: JSON-RPC 2.0 over Streamable HTTP, answering application/json.
// Speaks revision 2026-07-28 (server/discover, no handshake) and the handshake revisions through
// initialize + notifications/initialized. The tools act on the same store as REST and GraphQL.

import type { Req as IncomingMessage, Res as ServerResponse } from './http1.ts';
import { ApiError, createIssue, createPull, createRepo, mergePull, pullFiles, updateIssue } from './ops.ts';
import { commentJson, issueJson, pullJson, repoJson } from './rest.ts';
import { store, type Issue, type Repo } from './store.ts';

const SERVER_INFO = { name: 'forge-mcp', title: 'Forge MCP server', version: '1.0.0' };
const MODERN = '2026-07-28';
const SUPPORTED = [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: { listChanged: false } };

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run: (args: Json, base: string) => unknown;
}

const str = (description: string): Json => ({ type: 'string', description });
const int = (description: string): Json => ({ type: 'integer', description, minimum: 1 });
const OWNER = str('Repository owner (user login)');
const REPO = str('Repository name');

function needString(args: Json, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new ToolArgError(`missing required parameter: ${key}`);
  return v;
}

function needNumber(args: Json, key: string): number {
  const v = args[key];
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolArgError(`missing required parameter: ${key}`);
  return n;
}

class ToolArgError extends Error {}

function repoOf(args: Json): Repo {
  const owner = needString(args, 'owner');
  const name = needString(args, 'repo');
  const repo = store.getRepo(owner, name);
  if (!repo) throw new ApiError(404, `repository ${owner}/${name} not found`);
  return repo;
}

function issueOf(repo: Repo, n: number): Issue {
  const issue = repo.issueByNumber.get(n);
  if (!issue) throw new ApiError(404, `issue #${n} not found`);
  return issue;
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: str('Repository name'), description: str('Repository description'), private: { type: 'boolean', description: 'Whether the repository is private' }, autoInit: { type: 'boolean', description: 'Initialize with a README' } }, required: ['name'] },
    run: (a, base) => repoJson(createRepo({ name: needString(a, 'name'), description: a.description, private: a.private, auto_init: a.autoInit }), base),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO }, required: ['owner', 'repo'] },
    run: (a, base) => repoJson(repoOf(a), base),
  },
  {
    name: 'list_repos',
    title: 'List repositories',
    description: 'List repositories of the authenticated user.',
    inputSchema: { type: 'object', properties: { page: int('Page number'), perPage: int('Results per page') } },
    run: (_a, base) => ({ repositories: [...store.repos.values()].sort((x, y) => x.id - y.id).map((r) => repoJson(r, base)) }),
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create a new issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, title: str('Issue title'), body: str('Issue body (markdown)'), labels: { type: 'array', items: { type: 'string' }, description: 'Label names' }, assignees: { type: 'array', items: { type: 'string' }, description: 'Assignee logins' } }, required: ['owner', 'repo', 'title'] },
    run: (a, base) => {
      const repo = repoOf(a);
      const title = needString(a, 'title');
      return issueJson(repo, createIssue(repo, { title, body: a.body, labels: a.labels, assignees: a.assignees }), base);
    },
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Get an issue of a repository by number.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: int('Issue number') }, required: ['owner', 'repo', 'issue_number'] },
    run: (a, base) => {
      const repo = repoOf(a);
      return issueJson(repo, issueOf(repo, needNumber(a, 'issue_number')), base);
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List issues of a repository, filtered by state.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter (default open)' }, page: int('Page number'), perPage: int('Results per page') }, required: ['owner', 'repo'] },
    run: (a, base) => {
      const repo = repoOf(a);
      const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'open';
      const list = repo.issues.filter((i) => !i.pull && (state === 'all' || i.state === state));
      return { issues: [...list].reverse().map((i) => issueJson(repo, i, base)) };
    },
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description: 'Update the title, body or state of an issue.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: int('Issue number'), title: str('New title'), body: str('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } }, required: ['owner', 'repo', 'issue_number'] },
    run: (a, base) => {
      const repo = repoOf(a);
      const issue = issueOf(repo, needNumber(a, 'issue_number'));
      return issueJson(repo, updateIssue(repo, issue, { title: a.title, body: a.body, state: a.state }), base);
    },
  },
  {
    name: 'add_issue_comment',
    title: 'Add issue comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: int('Issue number'), body: str('Comment body') }, required: ['owner', 'repo', 'issue_number', 'body'] },
    run: (a, base) => {
      const repo = repoOf(a);
      const issue = issueOf(repo, needNumber(a, 'issue_number'));
      return commentJson(repo, issue, store.addComment(issue, needString(a, 'body')), base);
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, title: str('Pull request title'), head: str('Branch with the changes'), base: str('Branch to merge into'), body: str('Pull request description'), draft: { type: 'boolean', description: 'Open as a draft' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
    run: (a, base) => {
      const repo = repoOf(a);
      return pullJson(repo, createPull(repo, { title: needString(a, 'title'), head: needString(a, 'head'), base: needString(a, 'base'), body: a.body, draft: a.draft }), base);
    },
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request',
    description: 'Get a pull request by number.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: int('Pull request number') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a, base) => {
      const repo = repoOf(a);
      const issue = issueOf(repo, needNumber(a, 'pull_number'));
      if (!issue.pull) throw new ApiError(404, 'pull request not found');
      return pullJson(repo, issue, base);
    },
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List pull requests of a repository.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter (default open)' } }, required: ['owner', 'repo'] },
    run: (a, base) => {
      const repo = repoOf(a);
      const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'open';
      return { pulls: repo.issues.filter((i) => i.pull && (state === 'all' || i.state === state)).reverse().map((i) => pullJson(repo, i, base, false)) };
    },
  },
  {
    name: 'get_pull_request_files',
    title: 'Get pull request files',
    description: 'List the files a pull request changes.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: int('Pull request number') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a) => {
      const repo = repoOf(a);
      const issue = issueOf(repo, needNumber(a, 'pull_number'));
      if (!issue.pull) throw new ApiError(404, 'pull request not found');
      return { files: pullFiles(repo, issue).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: f.sha })) };
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request (merge, squash or rebase).',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: int('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default squash)' }, commit_title: str('Title of the merge commit'), commit_message: str('Extra detail for the merge commit') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a) => {
      const repo = repoOf(a);
      const issue = issueOf(repo, needNumber(a, 'pull_number'));
      if (!issue.pull) throw new ApiError(404, 'pull request not found');
      const r = mergePull(repo, issue, { merge_method: typeof a.merge_method === 'string' ? a.merge_method : 'squash', commit_title: a.commit_title, commit_message: a.commit_message });
      return { sha: r.sha, merged: true, message: r.message };
    },
  },
];

const TOOLS_LIST = TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name.toLowerCase(), t]));

function findTool(name: unknown): Tool | undefined {
  if (typeof name !== 'string') return undefined;
  const lower = name.toLowerCase();
  const direct = TOOL_BY_NAME.get(lower);
  if (direct) return direct;
  for (const t of TOOLS) if (lower.endsWith(`__${t.name}`) || lower.endsWith(`.${t.name}`) || lower.endsWith(`/${t.name}`)) return t;
  return undefined;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

let sessionSeq = 0;

function callTool(params: Json, base: string, id: unknown): Json {
  const tool = findTool(params.name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
  const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Json;
  const required = (tool.inputSchema.required ?? []) as string[];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length > 0) {
    return rpcResult(id, { content: [{ type: 'text', text: `missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` }], isError: true });
  }
  try {
    const out = tool.run(args, base);
    const result: Json = { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false };
    if (out && typeof out === 'object' && !Array.isArray(out)) result.structuredContent = out;
    return rpcResult(id, result);
  } catch (err) {
    const message = err instanceof ApiError ? `${err.message} (HTTP ${err.status})${Array.isArray(err.errors) && err.errors.length ? `: ${JSON.stringify(err.errors)}` : ''}` : err instanceof Error ? err.message : String(err);
    return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
  }
}

function dispatch(msg: Json, base: string, modern: boolean): { reply: Json | null; session?: string } {
  const id = msg.id;
  const isNotification = !('id' in msg) || id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { reply: isNotification && typeof msg.method === 'string' ? null : rpcError(id, -32600, 'Invalid Request') };
  }
  const method = msg.method;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;
  if (isNotification) return { reply: null };
  switch (method) {
    case 'server/discover':
      return { reply: rpcResult(id, { supportedVersions: SUPPORTED, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } }) };
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      const chosen = SUPPORTED.includes(asked) && asked !== MODERN ? asked : '2025-11-25';
      sessionSeq += 1;
      return { reply: rpcResult(id, { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge.' }), session: `forge-session-${sessionSeq}` };
    }
    case 'ping':
      return { reply: rpcResult(id, {}) };
    case 'tools/list':
      return { reply: rpcResult(id, { tools: TOOLS_LIST }) };
    case 'tools/call':
      return { reply: callTool(params, base, id) };
    case 'resources/list':
      return { reply: rpcResult(id, { resources: [] }) };
    case 'prompts/list':
      return { reply: rpcResult(id, { prompts: [] }) };
    default:
      void modern;
      return { reply: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

function write(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer, auth: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    write(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: this server does not offer an SSE stream' } }, { allow: 'POST, DELETE' });
    return;
  }
  if (method === 'DELETE') {
    write(res, 204, null);
    return;
  }
  if (method !== 'POST') {
    write(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } }, { allow: 'POST, DELETE' });
    return;
  }
  if (auth !== 'ok') {
    write(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: auth === 'missing' ? 'Requires authentication' : 'Bad credentials' } }, { 'www-authenticate': 'Bearer realm="forge"' });
    return;
  }
  const base = `http://${req.headers.host ?? 'localhost'}`;
  const headerVersion = (req.headers['mcp-protocol-version'] ?? '').toString();
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    const legacy = headerVersion !== '' && headerVersion < MODERN;
    write(res, legacy ? 200 : 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const modern = headerVersion >= MODERN;
  if (Array.isArray(body)) {
    const replies: Json[] = [];
    for (const m of body) {
      if (!m || typeof m !== 'object') {
        replies.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const r = dispatch(m as Json, base, modern);
      if (r.reply) replies.push(r.reply);
    }
    if (replies.length === 0) write(res, 202, null);
    else write(res, 200, replies);
    return;
  }
  if (!body || typeof body !== 'object') {
    write(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const r = dispatch(body as Json, base, modern);
  if (r.reply === null) {
    write(res, 202, null);
    return;
  }
  const headers: Record<string, string> = {};
  if (r.session) headers['mcp-session-id'] = r.session;
  write(res, 200, r.reply, headers);
}
