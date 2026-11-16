// GitHub REST v3 under /api/v3: routing and the JSON shapes api.github.com answers.

import { isOid, parseIdent, parseTag } from './git.ts';
import {
  ApiError, addLabels, createIssue, createLabel, createPull, createRef, createRepo, deleteContent, deleteRef,
  diffCommits, isMergeable, logFrom, mergePull, pullCommits, pullFiles, pullTips, putContent, resolveRef,
  updateIssue, updateRef, updateRepo,
} from './ops.ts';
import { store, type Comment, type Issue, type Label, type Repo } from './store.ts';

export interface Ctx {
  method: string;
  segs: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown;
  base: string; // http://host
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ status, body, headers });

// ------------------------------------------------------------------ serializers

export function userJson(base: string): Record<string, unknown> {
  const login = store.viewer.login;
  const api = `${base}/api/v3/users/${login}`;
  return {
    login,
    id: store.viewer.id,
    node_id: nodeId('U', store.viewer.id),
    avatar_url: `${base}/avatars/${login}`,
    gravatar_id: '',
    url: api,
    html_url: `${base}/${login}`,
    followers_url: `${api}/followers`,
    following_url: `${api}/following{/other_user}`,
    gists_url: `${api}/gists{/gist_id}`,
    starred_url: `${api}/starred{/owner}{/repo}`,
    subscriptions_url: `${api}/subscriptions`,
    organizations_url: `${api}/orgs`,
    repos_url: `${api}/repos`,
    events_url: `${api}/events{/privacy}`,
    received_events_url: `${api}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

export function nodeId(prefix: string, id: number): string {
  return `${prefix}_${Buffer.from(`forge:${prefix}:${id}`).toString('base64url')}`;
}

export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const login = store.viewer.login;
  const full = `${login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${full}`;
  return {
    id: repo.id,
    node_id: nodeId('R', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(base),
    html_url: `${base}/${full}`,
    description: repo.description,
    fork: false,
    url: api,
    forks_url: `${api}/forks`,
    keys_url: `${api}/keys{/key_id}`,
    collaborators_url: `${api}/collaborators{/collaborator}`,
    teams_url: `${api}/teams`,
    hooks_url: `${api}/hooks`,
    issue_events_url: `${api}/issues/events{/number}`,
    events_url: `${api}/events`,
    assignees_url: `${api}/assignees{/user}`,
    branches_url: `${api}/branches{/branch}`,
    tags_url: `${api}/tags`,
    blobs_url: `${api}/git/blobs{/sha}`,
    git_tags_url: `${api}/git/tags{/sha}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    trees_url: `${api}/git/trees{/sha}`,
    statuses_url: `${api}/statuses/{sha}`,
    languages_url: `${api}/languages`,
    stargazers_url: `${api}/stargazers`,
    contributors_url: `${api}/contributors`,
    subscribers_url: `${api}/subscribers`,
    subscription_url: `${api}/subscription`,
    commits_url: `${api}/commits{/sha}`,
    git_commits_url: `${api}/git/commits{/sha}`,
    comments_url: `${api}/comments{/number}`,
    issue_comment_url: `${api}/issues/comments{/number}`,
    contents_url: `${api}/contents/{+path}`,
    compare_url: `${api}/compare/{base}...{head}`,
    merges_url: `${api}/merges`,
    archive_url: `${api}/{archive_format}{/ref}`,
    downloads_url: `${api}/downloads`,
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    milestones_url: `${api}/milestones{/number}`,
    notifications_url: `${api}/notifications{?since,all,participating}`,
    labels_url: `${api}/labels{/name}`,
    releases_url: `${api}/releases{/id}`,
    deployments_url: `${api}/deployments`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt ?? repo.createdAt,
    git_url: `${base.replace(/^http/, 'git')}/${full}.git`,
    ssh_url: `git@forge:${full}.git`,
    clone_url: `${base}/${full}.git`,
    svn_url: `${base}/${full}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
  };
}

export function labelJson(repo: Repo, label: Label, base: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('LA', label.id),
    url: `${base}/api/v3/repos/${store.viewer.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  const full = `${store.viewer.login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${full}`;
  const kind = issue.pull ? 'pull' : 'issues';
  const out: Record<string, unknown> = {
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: `${base}/${full}/${kind}/${issue.number}`,
    id: issue.id,
    node_id: nodeId(issue.pull ? 'PR' : 'I', issue.id),
    number: issue.number,
    title: issue.title,
    user: userJson(base),
    labels: issue.labels.map((n) => repo.labels.get(n.toLowerCase())).filter((l): l is Label => l !== undefined).map((l) => labelJson(repo, l, base)),
    state: issue.state,
    locked: false,
    assignee: issue.assignees.length > 0 ? userJson(base) : null,
    assignees: issue.assignees.length > 0 ? [userJson(base)] : [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    body: issue.body ?? '',
    closed_by: issue.state === 'closed' ? userJson(base) : null,
    reactions: { url: `${api}/issues/${issue.number}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `${api}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.stateReason,
  };
  if (issue.pull) {
    out.draft = issue.pull.draft;
    out.pull_request = {
      url: `${api}/pulls/${issue.number}`,
      html_url: `${base}/${full}/pull/${issue.number}`,
      diff_url: `${base}/${full}/pull/${issue.number}.diff`,
      patch_url: `${base}/${full}/pull/${issue.number}.patch`,
      merged_at: issue.pull.mergedAt,
    };
  }
  return out;
}

export function commentJson(repo: Repo, issue: Issue, c: Comment, base: string): Record<string, unknown> {
  const full = `${store.viewer.login}/${repo.name}`;
  return {
    url: `${base}/api/v3/repos/${full}/issues/comments/${c.id}`,
    html_url: `${base}/${full}/issues/${issue.number}#issuecomment-${c.id}`,
    issue_url: `${base}/api/v3/repos/${full}/issues/${issue.number}`,
    id: c.id,
    node_id: nodeId('IC', c.id),
    user: userJson(base),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: 'OWNER',
    body: c.body,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    performed_via_github_app: null,
  };
}

function branchRef(repo: Repo, branch: string, sha: string, base: string): Record<string, unknown> {
  return {
    label: `${store.viewer.login}:${branch}`,
    ref: branch,
    sha,
    user: userJson(base),
    repo: repoJson(repo, base),
  };
}

export function pullJson(repo: Repo, issue: Issue, base: string, full = true): Record<string, unknown> {
  const p = issue.pull!;
  const { headSha, baseSha } = pullTips(repo, issue);
  const fullName = `${store.viewer.login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${fullName}`;
  const out: Record<string, unknown> = {
    url: `${api}/pulls/${issue.number}`,
    id: issue.id,
    node_id: nodeId('PR', issue.id),
    html_url: `${base}/${fullName}/pull/${issue.number}`,
    diff_url: `${base}/${fullName}/pull/${issue.number}.diff`,
    patch_url: `${base}/${fullName}/pull/${issue.number}.patch`,
    issue_url: `${api}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    user: userJson(base),
    body: issue.body ?? '',
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: issue.labels.map((n) => repo.labels.get(n.toLowerCase())).filter((l): l is Label => l !== undefined).map((l) => labelJson(repo, l, base)),
    milestone: null,
    draft: p.draft,
    commits_url: `${api}/pulls/${issue.number}/commits`,
    review_comments_url: `${api}/pulls/${issue.number}/comments`,
    review_comment_url: `${api}/pulls/comments{/number}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    statuses_url: `${api}/statuses/${headSha}`,
    head: branchRef(repo, p.head, headSha, base),
    base: branchRef(repo, p.base, baseSha, base),
    _links: {
      self: { href: `${api}/pulls/${issue.number}` },
      html: { href: `${base}/${fullName}/pull/${issue.number}` },
      issue: { href: `${api}/issues/${issue.number}` },
      comments: { href: `${api}/issues/${issue.number}/comments` },
      review_comments: { href: `${api}/pulls/${issue.number}/comments` },
      review_comment: { href: `${api}/pulls/comments{/number}` },
      commits: { href: `${api}/pulls/${issue.number}/commits` },
      statuses: { href: `${api}/statuses/${headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
  };
  if (full) {
    const files = issue.state === 'open' || p.merged ? pullFiles(repo, issue) : [];
    const mergeable = issue.state === 'open' ? isMergeable(repo, issue) : null;
    Object.assign(out, {
      merged: p.merged,
      mergeable,
      rebaseable: mergeable,
      mergeable_state: issue.state !== 'open' ? 'unknown' : mergeable ? 'clean' : 'dirty',
      merged_by: p.merged ? userJson(base) : null,
      comments: issue.comments.length,
      review_comments: 0,
      maintainer_can_modify: false,
      commits: pullCommits(repo, issue).length,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      changed_files: files.length,
    });
  }
  return out;
}

function identJson(raw: string): Record<string, unknown> {
  const id = parseIdent(raw);
  return { name: id.name, email: id.email, date: new Date(id.time * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

export function commitJson(repo: Repo, oid: string, base: string, withFiles = false): Record<string, unknown> {
  const c = repo.db.commit(oid)!;
  const fullName = `${store.viewer.login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${fullName}`;
  const out: Record<string, unknown> = {
    sha: oid,
    node_id: nodeId('C', parseInt(oid.slice(0, 8), 16)),
    commit: {
      author: identJson(c.author),
      committer: identJson(c.committer),
      message: c.message.replace(/\n$/, ''),
      tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
      url: `${api}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${api}/commits/${oid}`,
    html_url: `${base}/${fullName}/commit/${oid}`,
    comments_url: `${api}/commits/${oid}/comments`,
    author: userJson(base),
    committer: userJson(base),
    parents: c.parents.map((p) => ({ sha: p, url: `${api}/commits/${p}`, html_url: `${base}/${fullName}/commit/${p}` })),
  };
  if (withFiles) {
    const files = diffCommits(repo, c.parents[0] ?? null, oid);
    out.stats = { total: files.reduce((s, f) => s + f.changes, 0), additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0) };
    out.files = files.map((f) => fileJson(repo, f, base, oid));
  }
  return out;
}

function fileJson(repo: Repo, f: ReturnType<typeof diffCommits>[number], base: string, ref: string): Record<string, unknown> {
  const fullName = `${store.viewer.login}/${repo.name}`;
  return {
    sha: f.sha,
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    blob_url: `${base}/${fullName}/blob/${ref}/${f.filename}`,
    raw_url: `${base}/${fullName}/raw/${ref}/${f.filename}`,
    contents_url: `${base}/api/v3/repos/${fullName}/contents/${f.filename}?ref=${ref}`,
    patch: f.patch,
  };
}

function contentEntryJson(repo: Repo, path: string, oid: string, mode: string, base: string, ref: string, withContent: boolean): Record<string, unknown> {
  const fullName = `${store.viewer.login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${fullName}`;
  const isDir = mode === '40000';
  const type = isDir ? 'dir' : mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : 'file';
  const obj = repo.db.get(oid);
  const size = isDir || !obj ? 0 : obj.data.length;
  const name = path.split('/').pop() ?? path;
  const self = `${api}/contents/${path}?ref=${ref}`;
  const git = `${api}/git/${isDir ? 'trees' : 'blobs'}/${oid}`;
  const html = `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/${ref}/${path}`;
  const out: Record<string, unknown> = {
    type,
    name,
    path,
    sha: oid,
    size,
    url: self,
    html_url: html,
    git_url: git,
    download_url: isDir ? null : `${base}/${fullName}/raw/${ref}/${path}`,
    _links: { self, git, html },
  };
  if (withContent && !isDir && obj) {
    out.encoding = 'base64';
    out.content = (obj.data.toString('base64').match(/.{1,60}/g) ?? ['']).join('\n') + (obj.data.length > 0 ? '\n' : '');
  }
  return out;
}

function contentCommitJson(repo: Repo, oid: string, base: string): Record<string, unknown> {
  const c = repo.db.commit(oid)!;
  const fullName = `${store.viewer.login}/${repo.name}`;
  const api = `${base}/api/v3/repos/${fullName}`;
  return {
    sha: oid,
    node_id: nodeId('C', parseInt(oid.slice(0, 8), 16)),
    url: `${api}/git/commits/${oid}`,
    html_url: `${base}/${fullName}/commit/${oid}`,
    author: identJson(c.author),
    committer: identJson(c.committer),
    message: c.message.replace(/\n$/, ''),
    tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
    parents: c.parents.map((p) => ({ sha: p, url: `${api}/git/commits/${p}`, html_url: `${base}/${fullName}/commit/${p}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
  };
}

// ------------------------------------------------------------------ pagination

function page<T>(ctx: Ctx, items: T[], path: string): { items: T[]; headers: Record<string, string> } {
  const perRaw = parseInt(ctx.query.get('per_page') ?? '30', 10);
  const per = Math.min(100, Math.max(1, Number.isFinite(perRaw) ? perRaw : 30));
  const pRaw = parseInt(ctx.query.get('page') ?? '1', 10);
  const p = Math.max(1, Number.isFinite(pRaw) ? pRaw : 1);
  const last = Math.max(1, Math.ceil(items.length / per));
  const slice = items.slice((p - 1) * per, p * per);
  const links: string[] = [];
  const mk = (n: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(per));
    q.set('page', String(n));
    return `<${ctx.base}/api/v3/${path}?${q.toString()}>`;
  };
  if (p > 1) {
    links.push(`${mk(p - 1)}; rel="prev"`);
  }
  if (p < last) {
    links.push(`${mk(p + 1)}; rel="next"`);
    links.push(`${mk(last)}; rel="last"`);
  }
  if (p > 1) links.push(`${mk(1)}; rel="first"`);
  return { items: slice, headers: links.length ? { link: links.join(', ') } : {} };
}

// ------------------------------------------------------------------ routing

function obj(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Problems parsing JSON');
  return body as Record<string, unknown>;
}

function notFound(): never {
  throw new ApiError(404, 'Not Found');
}

function needRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (!repo) notFound();
  return repo;
}

function needIssue(repo: Repo, raw: string): Issue {
  const n = Number(raw);
  if (!Number.isInteger(n)) notFound();
  const issue = repo.issueByNumber.get(n);
  if (!issue) notFound();
  return issue;
}

function needPull(repo: Repo, raw: string): Issue {
  const issue = needIssue(repo, raw);
  if (!issue.pull) notFound();
  return issue;
}

export function handleRest(ctx: Ctx): Reply {
  try {
    return route(ctx);
  } catch (err) {
    if (err instanceof ApiError) {
      const body: Record<string, unknown> = { message: err.message, documentation_url: 'https://docs.github.com/rest', status: String(err.status) };
      if (err.errors) body.errors = err.errors;
      return json(err.status, body);
    }
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { message: `Server Error: ${message}` });
  }
}

function route(ctx: Ctx): Reply {
  const { method, segs, base } = ctx;
  const s = segs;
  const n = s.length;
  if (n === 0) {
    if (method !== 'GET') notFound();
    return json(200, {
      current_user_url: `${base}/api/v3/user`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      issues_url: `${base}/api/v3/issues`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org, workflow', 'x-accepted-oauth-scopes': '' });
  }
  if (s[0] === 'meta' && n === 1 && method === 'GET') {
    return json(200, { verifiable_password_authentication: false, installed_version: '3.14.0', hooks: [], git: [], web: [], api: [] });
  }
  if (s[0] === 'rate_limit' && n === 1) {
    const r = { limit: 5000, used: 0, remaining: 5000, reset: 0 };
    return json(200, { resources: { core: r, graphql: r, search: r }, rate: r });
  }
  if (s[0] === 'zen' && n === 1) return json(200, { message: 'Keep it logically awesome.' });
  if (s[0] === 'octocat' && n === 1) return json(200, { message: 'forge' });
  if (s[0] === 'user' && n === 1 && method === 'GET') return json(200, { ...userJson(base), name: store.viewer.name, email: store.viewer.email, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', public_repos: [...store.repos.values()].filter((r) => !r.private).length });
  if (s[0] === 'user' && s[1] === 'repos' && n === 2) {
    if (method === 'GET') return listRepos(ctx, 'user/repos');
    if (method === 'POST') return json(201, repoJson(createRepo(obj(ctx.body)), base));
    notFound();
  }
  if (s[0] === 'users' && n >= 2) {
    if (!store.ownerIs(s[1] as string)) notFound();
    if (n === 2 && method === 'GET') return json(200, userJson(base));
    if (n === 3 && s[2] === 'repos' && method === 'GET') return listRepos(ctx, `users/${s[1]}/repos`, true);
    notFound();
  }
  if (s[0] === 'search' && s[1] === 'issues' && n === 2 && method === 'GET') return searchIssues(ctx);
  if (s[0] === 'search' && s[1] === 'repositories' && n === 2 && method === 'GET') {
    const q = (ctx.query.get('q') ?? '').toLowerCase();
    const words = q.split(/\s+/).filter((w) => w && !w.includes(':'));
    const items = [...store.repos.values()].filter((r) => words.every((w) => r.name.toLowerCase().includes(w) || (r.description ?? '').toLowerCase().includes(w)));
    const pg = page(ctx, items, 'search/repositories');
    return json(200, { total_count: items.length, incomplete_results: false, items: pg.items.map((r) => repoJson(r, base)) }, pg.headers);
  }
  if (s[0] === 'repos' && n >= 3) return repoRoutes(ctx, needRepo(s[1] as string, s[2] as string));
  notFound();
}

function listRepos(ctx: Ctx, path: string, publicOnly = false): Reply {
  let repos = [...store.repos.values()];
  if (publicOnly) repos = repos.filter((r) => !r.private);
  const vis = ctx.query.get('visibility');
  if (vis === 'public') repos = repos.filter((r) => !r.private);
  if (vis === 'private') repos = repos.filter((r) => r.private);
  const sort = ctx.query.get('sort') ?? 'full_name';
  const dir = ctx.query.get('direction') ?? (sort === 'full_name' ? 'asc' : 'desc');
  if (sort === 'created') repos.sort((a, b) => a.id - b.id);
  else if (sort === 'updated' || sort === 'pushed') repos.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id - b.id));
  else repos.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  if (dir === 'desc') repos.reverse();
  const pg = page(ctx, repos, path);
  return json(200, pg.items.map((r) => repoJson(r, ctx.base)), pg.headers);
}

function filterIssues(repo: Repo, ctx: Ctx, pullsToo: boolean): Issue[] {
  const state = ctx.query.get('state') ?? 'open';
  let list = repo.issues.filter((i) => (pullsToo || !i.pull) && (state === 'all' || i.state === state));
  const labels = ctx.query.get('labels');
  if (labels) {
    const want = labels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
    list = list.filter((i) => want.every((w) => i.labels.some((l) => l.toLowerCase() === w)));
  }
  const sort = ctx.query.get('sort') ?? 'created';
  const dir = ctx.query.get('direction') ?? 'desc';
  const key = (i: Issue): string => (sort === 'updated' ? i.updatedAt : sort === 'comments' ? String(i.comments.length).padStart(8, '0') : i.createdAt);
  list = [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.number - b.number;
  });
  if (dir === 'desc') list.reverse();
  return list;
}

function searchIssues(ctx: Ctx): Reply {
  const q = ctx.query.get('q') ?? '';
  const terms = q.split(/\s+/).filter(Boolean);
  let repoFilter: Repo | undefined;
  let state: string | null = null;
  let type: string | null = null;
  const words: string[] = [];
  for (const t of terms) {
    const m = /^(\w+):(.+)$/.exec(t);
    if (!m) {
      words.push(t.toLowerCase());
      continue;
    }
    const [, k, v] = m as unknown as [string, string, string];
    if (k === 'repo') {
      const [o, r] = v.split('/');
      repoFilter = store.getRepo(o ?? '', r ?? '');
      if (!repoFilter) return json(200, { total_count: 0, incomplete_results: false, items: [] });
    } else if (k === 'is' && (v === 'open' || v === 'closed')) state = v;
    else if (k === 'state') state = v;
    else if (k === 'is' && (v === 'issue' || v === 'pr')) type = v;
    else if (k === 'type') type = v;
  }
  const repos = repoFilter ? [repoFilter] : [...store.repos.values()];
  const items: Array<{ repo: Repo; issue: Issue }> = [];
  for (const r of repos) {
    for (const i of r.issues) {
      if (state && i.state !== state) continue;
      if (type === 'issue' && i.pull) continue;
      if ((type === 'pr' || type === 'pull-request') && !i.pull) continue;
      const text = `${i.title} ${i.body ?? ''}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
      items.push({ repo: r, issue: i });
    }
  }
  items.sort((a, b) => (a.issue.createdAt < b.issue.createdAt ? 1 : a.issue.createdAt > b.issue.createdAt ? -1 : b.issue.number - a.issue.number));
  const pg = page(ctx, items, 'search/issues');
  return json(200, { total_count: items.length, incomplete_results: false, items: pg.items.map((x) => ({ ...issueJson(x.repo, x.issue, ctx.base), score: 1 })) }, pg.headers);
}

function repoRoutes(ctx: Ctx, repo: Repo): Reply {
  const { method, base } = ctx;
  const s = ctx.segs.slice(3);
  const n = s.length;
  const repoPath = `repos/${store.viewer.login}/${repo.name}`;
  if (n === 0) {
    if (method === 'GET') return json(200, repoJson(repo, base));
    if (method === 'PATCH') return json(200, repoJson(updateRepo(repo, obj(ctx.body)), base));
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204 };
    }
    notFound();
  }
  const head = s[0];
  // ---- branches
  if (head === 'branches') {
    if (n === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).map(([r, oid]) => ({ name: r.slice(11), oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const pg = page(ctx, branches, `${repoPath}/branches`);
      return json(200, pg.items.map((b) => ({ name: b.name, commit: { sha: b.oid, url: `${base}/api/v3/${repoPath}/commits/${b.oid}` }, protected: false })), pg.headers);
    }
    if (n >= 2 && method === 'GET') {
      const name = s.slice(1).join('/');
      const oid = store.branchTip(repo, name);
      if (!oid) throw new ApiError(404, 'Branch not found');
      return json(200, { name, commit: commitJson(repo, oid, base), _links: { self: `${base}/api/v3/${repoPath}/branches/${name}`, html: `${base}/${store.viewer.login}/${repo.name}/tree/${name}` }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } }, protection_url: `${base}/api/v3/${repoPath}/branches/${name}/protection` });
    }
    notFound();
  }
  if (head === 'tags' && n === 1 && method === 'GET') {
    const tags = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/tags/')).map(([r, oid]) => ({ name: r.slice(10), commit: { sha: repo.db.peel(oid), url: `${base}/api/v3/${repoPath}/commits/${repo.db.peel(oid)}` }, node_id: nodeId('REF', 0) }));
    return json(200, tags);
  }
  // ---- commits
  if (head === 'commits') {
    if (n === 1 && method === 'GET') {
      const sha = ctx.query.get('sha');
      const tip = resolveRef(repo, sha);
      if (!tip) {
        if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
        notFound();
      }
      const path = ctx.query.get('path') ?? undefined;
      const per = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
      const pg = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
      const all = logFrom(repo, tip, per * pg + 1, path);
      const slice = all.slice((pg - 1) * per, pg * per);
      const headers: Record<string, string> = {};
      if (all.length > pg * per) {
        const q = new URLSearchParams(ctx.query);
        q.set('page', String(pg + 1));
        q.set('per_page', String(per));
        headers.link = `<${base}/api/v3/${repoPath}/commits?${q.toString()}>; rel="next"`;
      }
      return json(200, slice.map((oid) => commitJson(repo, oid, base)), headers);
    }
    if (n === 2 && method === 'GET') {
      const oid = resolveRef(repo, s[1]);
      if (!oid || !repo.db.commit(oid)) throw new ApiError(422, `No commit found for SHA: ${s[1]}`);
      return json(200, commitJson(repo, oid, base, true));
    }
    notFound();
  }
  if (head === 'compare' && n === 2 && method === 'GET') {
    const spec = s[1] as string;
    const [b, h] = spec.split('...');
    const bo = resolveRef(repo, b);
    const ho = resolveRef(repo, h);
    if (!bo || !ho) notFound();
    const mb = repo.db.mergeBase(bo, ho);
    const files = diffCommits(repo, mb, ho);
    const ahead: string[] = [];
    for (const c of logFrom(repo, ho, 10000)) if (!mb || !repo.db.isAncestor(c, mb)) ahead.push(c);
    return json(200, { status: ahead.length === 0 ? 'identical' : 'ahead', ahead_by: ahead.length, behind_by: 0, total_commits: ahead.length, merge_base_commit: mb ? commitJson(repo, mb, base) : null, commits: ahead.reverse().map((c) => commitJson(repo, c, base)), files: files.map((f) => fileJson(repo, f, base, ho)) });
  }
  // ---- git database
  if (head === 'git') return gitRoutes(ctx, repo, s.slice(1));
  // ---- contents
  if (head === 'contents') {
    const path = s.slice(1).map((p) => decodeURIComponent(p)).join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref');
      const tip = resolveRef(repo, ref);
      if (!tip) {
        if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
        throw new ApiError(404, `No commit found for the ref ${ref}`);
      }
      const c = repo.db.commit(tip)!;
      const refName = ref ?? repo.defaultBranch;
      const entry = repo.db.lookupPath(c.tree, path);
      if (!entry) notFound();
      if (entry.mode === '40000') {
        const entries = repo.db.tree(entry.oid) ?? [];
        return json(200, entries.map((e) => contentEntryJson(repo, path === '' ? e.name : `${path}/${e.name}`, e.oid, e.mode, base, refName, false)));
      }
      return json(200, contentEntryJson(repo, path, entry.oid, entry.mode, base, refName, true));
    }
    if (method === 'PUT') {
      const { created, result } = putContent(repo, path, obj(ctx.body));
      return json(created ? 201 : 200, { content: { ...contentEntryJson(repo, result.path, result.blob, '100644', base, repo.defaultBranch, false), encoding: 'base64' }, commit: contentCommitJson(repo, result.commit, base) });
    }
    if (method === 'DELETE') {
      const result = deleteContent(repo, path, obj(ctx.body));
      return json(200, { content: null, commit: contentCommitJson(repo, result.commit, base) });
    }
    notFound();
  }
  if (head === 'readme' && method === 'GET') {
    const tip = resolveRef(repo, ctx.query.get('ref'));
    if (!tip) notFound();
    const entries = repo.db.tree(repo.db.commit(tip)!.tree) ?? [];
    const readme = entries.find((e) => /^readme(\.|$)/i.test(e.name) && e.mode !== '40000');
    if (!readme) notFound();
    return json(200, contentEntryJson(repo, readme.name, readme.oid, readme.mode, base, ctx.query.get('ref') ?? repo.defaultBranch, true));
  }
  // ---- labels
  if (head === 'labels') {
    if (n === 1 && method === 'GET') {
      const pg = page(ctx, [...repo.labels.values()], `${repoPath}/labels`);
      return json(200, pg.items.map((l) => labelJson(repo, l, base)), pg.headers);
    }
    if (n === 1 && method === 'POST') return json(201, labelJson(repo, createLabel(repo, obj(ctx.body)), base));
    if (n === 2) {
      const name = decodeURIComponent(s[1] as string);
      const label = repo.labels.get(name.toLowerCase());
      if (!label) notFound();
      if (method === 'GET') return json(200, labelJson(repo, label, base));
      if (method === 'PATCH') {
        const b = obj(ctx.body);
        if (typeof b.new_name === 'string') {
          repo.labels.delete(label.name.toLowerCase());
          for (const i of repo.issues) i.labels = i.labels.map((l) => (l === label.name ? (b.new_name as string) : l));
          label.name = b.new_name;
          repo.labels.set(label.name.toLowerCase(), label);
        }
        if (typeof b.color === 'string') label.color = b.color.replace(/^#/, '');
        if (typeof b.description === 'string') label.description = b.description;
        return json(200, labelJson(repo, label, base));
      }
      if (method === 'DELETE') {
        repo.labels.delete(label.name.toLowerCase());
        for (const i of repo.issues) i.labels = i.labels.filter((l) => l !== label.name);
        return { status: 204 };
      }
    }
    notFound();
  }
  // ---- issues
  if (head === 'issues') {
    if (n === 1 && method === 'GET') {
      const pg = page(ctx, filterIssues(repo, ctx, true), `${repoPath}/issues`);
      return json(200, pg.items.map((i) => issueJson(repo, i, base)), pg.headers);
    }
    if (n === 1 && method === 'POST') return json(201, issueJson(repo, createIssue(repo, obj(ctx.body)), base));
    if (n === 3 && s[1] === 'comments' && method === 'GET') {
      const all: Array<{ issue: Issue; c: Comment }> = [];
      for (const i of repo.issues) for (const c of i.comments) all.push({ issue: i, c });
      all.sort((a, b) => a.c.id - b.c.id);
      void all;
    }
    if (s[1] === 'comments' && n === 3) {
      const id = Number(s[2]);
      for (const i of repo.issues) {
        const idx = i.comments.findIndex((c) => c.id === id);
        if (idx < 0) continue;
        const c = i.comments[idx] as Comment;
        if (method === 'GET') return json(200, commentJson(repo, i, c, base));
        if (method === 'PATCH') {
          const b = obj(ctx.body);
          if (typeof b.body !== 'string') throw new ApiError(422, 'Validation Failed');
          c.body = b.body;
          c.updatedAt = store.now();
          return json(200, commentJson(repo, i, c, base));
        }
        if (method === 'DELETE') {
          i.comments.splice(idx, 1);
          return { status: 204 };
        }
      }
      notFound();
    }
    if (s[1] === 'comments' && n === 2 && method === 'GET') {
      const all: Array<{ issue: Issue; c: Comment }> = [];
      for (const i of repo.issues) for (const c of i.comments) all.push({ issue: i, c });
      all.sort((a, b) => a.c.id - b.c.id);
      const pg = page(ctx, all, `${repoPath}/issues/comments`);
      return json(200, pg.items.map((x) => commentJson(repo, x.issue, x.c, base)), pg.headers);
    }
    const issue = needIssue(repo, s[1] as string);
    if (n === 2) {
      if (method === 'GET') return json(200, issueJson(repo, issue, base));
      if (method === 'PATCH') return json(200, issueJson(repo, updateIssue(repo, issue, obj(ctx.body)), base));
      notFound();
    }
    if (s[2] === 'comments' && n === 3) {
      if (method === 'GET') {
        const pg = page(ctx, issue.comments, `${repoPath}/issues/${issue.number}/comments`);
        return json(200, pg.items.map((c) => commentJson(repo, issue, c, base)), pg.headers);
      }
      if (method === 'POST') {
        const b = obj(ctx.body);
        if (typeof b.body !== 'string' || b.body === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
        return json(201, commentJson(repo, issue, store.addComment(issue, b.body), base));
      }
    }
    if (s[2] === 'labels') {
      if (n === 3 && method === 'GET') return json(200, issue.labels.map((l) => repo.labels.get(l.toLowerCase())).filter((l): l is Label => !!l).map((l) => labelJson(repo, l, base)));
      if (n === 3 && method === 'POST') {
        addLabels(repo, issue, ctx.body);
        return json(200, issue.labels.map((l) => labelJson(repo, repo.labels.get(l.toLowerCase())!, base)));
      }
      if (n === 3 && method === 'PUT') {
        issue.labels = [];
        addLabels(repo, issue, ctx.body);
        return json(200, issue.labels.map((l) => labelJson(repo, repo.labels.get(l.toLowerCase())!, base)));
      }
      if (n === 3 && method === 'DELETE') {
        issue.labels = [];
        return { status: 204 };
      }
      if (n === 4 && method === 'DELETE') {
        const name = decodeURIComponent(s[3] as string).toLowerCase();
        if (!issue.labels.some((l) => l.toLowerCase() === name)) throw new ApiError(404, 'Label does not exist');
        issue.labels = issue.labels.filter((l) => l.toLowerCase() !== name);
        return json(200, issue.labels.map((l) => labelJson(repo, repo.labels.get(l.toLowerCase())!, base)));
      }
    }
    notFound();
  }
  // ---- pulls
  if (head === 'pulls') {
    if (n === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.issues.filter((i) => i.pull && (state === 'all' || i.state === state));
      const h = ctx.query.get('head');
      const b = ctx.query.get('base');
      if (h) list = list.filter((i) => i.pull!.head === (h.includes(':') ? h.slice(h.indexOf(':') + 1) : h));
      if (b) list = list.filter((i) => i.pull!.base === b);
      const dir = ctx.query.get('direction') ?? 'desc';
      list = [...list].sort((x, y) => x.number - y.number);
      if (dir === 'desc') list.reverse();
      const pg = page(ctx, list, `${repoPath}/pulls`);
      return json(200, pg.items.map((i) => pullJson(repo, i, base, false)), pg.headers);
    }
    if (n === 1 && method === 'POST') return json(201, pullJson(repo, createPull(repo, obj(ctx.body)), base));
    const issue = needPull(repo, s[1] as string);
    if (n === 2) {
      if (method === 'GET') return json(200, pullJson(repo, issue, base));
      if (method === 'PATCH') {
        const b = obj(ctx.body);
        updateIssue(repo, issue, { title: b.title, body: b.body, state: b.state });
        if (typeof b.base === 'string' && store.branchTip(repo, b.base)) issue.pull!.base = b.base;
        return json(200, pullJson(repo, issue, base));
      }
      notFound();
    }
    if (n === 3 && s[2] === 'files' && method === 'GET') {
      const files = pullFiles(repo, issue);
      const pg = page(ctx, files, `${repoPath}/pulls/${issue.number}/files`);
      return json(200, pg.items.map((f) => fileJson(repo, f, base, pullTips(repo, issue).headSha)), pg.headers);
    }
    if (n === 3 && s[2] === 'commits' && method === 'GET') {
      return json(200, pullCommits(repo, issue).map((c) => commitJson(repo, c, base)));
    }
    if (n === 3 && s[2] === 'merge') {
      if (method === 'GET') return issue.pull!.merged ? { status: 204 } : json(404, { message: 'Not Found' });
      if (method === 'PUT') {
        const r = mergePull(repo, issue, obj(ctx.body));
        return json(200, { sha: r.sha, merged: true, message: r.message });
      }
    }
    if (n === 3 && (s[2] === 'reviews' || s[2] === 'comments' || s[2] === 'requested_reviewers') && method === 'GET') {
      return json(200, s[2] === 'requested_reviewers' ? { users: [], teams: [] } : []);
    }
    notFound();
  }
  if (head === 'merges' && n === 1 && method === 'POST') {
    const b = obj(ctx.body);
    const baseTip = typeof b.base === 'string' ? store.branchTip(repo, b.base) : undefined;
    const headTip = typeof b.head === 'string' ? resolveRef(repo, b.head) : undefined;
    if (!baseTip || !headTip) notFound();
    if (repo.db.isAncestor(headTip, baseTip)) return { status: 204 };
    throw new ApiError(409, 'Merge conflict');
  }
  if (head === 'collaborators' && n === 1) return json(200, [userJson(base)]);
  if (head === 'assignees' && n === 1) return json(200, [userJson(base)]);
  if (head === 'languages' && n === 1) return json(200, {});
  if (head === 'topics' && n === 1) return json(200, { names: [] });
  if (head === 'releases' && n === 1 && method === 'GET') return json(200, []);
  if (head === 'milestones' && n === 1 && method === 'GET') return json(200, []);
  notFound();
}

function gitRoutes(ctx: Ctx, repo: Repo, s: string[]): Reply {
  const { method, base } = ctx;
  const n = s.length;
  const repoPath = `repos/${store.viewer.login}/${repo.name}`;
  const refJson = (ref: string, oid: string): Record<string, unknown> => {
    const o = repo.db.get(oid);
    return { ref, node_id: nodeId('REF', repo.id), url: `${base}/api/v3/${repoPath}/git/${ref}`, object: { sha: oid, type: o?.type ?? 'commit', url: `${base}/api/v3/${repoPath}/git/${o?.type === 'tag' ? 'tags' : 'commits'}/${oid}` } };
  };
  if (s[0] === 'refs') {
    if (n === 1 && method === 'POST') {
      const b = obj(ctx.body);
      const r = createRef(repo, b.ref, b.sha);
      return json(201, refJson(r.ref, r.sha));
    }
    if (n === 1 && method === 'GET') return json(200, [...repo.refs.entries()].sort().map(([r, o]) => refJson(r, o)));
    const ref = `refs/${s.slice(1).map((x) => decodeURIComponent(x)).join('/')}`;
    if (method === 'GET') {
      const oid = repo.refs.get(ref);
      if (oid) return json(200, refJson(ref, oid));
      const matches = [...repo.refs.entries()].filter(([r]) => r.startsWith(`${ref}/`)).sort();
      if (matches.length) return json(200, matches.map(([r, o]) => refJson(r, o)));
      notFound();
    }
    if (method === 'PATCH') {
      const b = obj(ctx.body);
      const r = updateRef(repo, ref, b.sha, b.force === true);
      return json(200, refJson(r.ref, r.sha));
    }
    if (method === 'DELETE') {
      deleteRef(repo, ref);
      return { status: 204 };
    }
    notFound();
  }
  if (s[0] === 'ref' && n >= 2 && method === 'GET') {
    const ref = `refs/${s.slice(1).map((x) => decodeURIComponent(x)).join('/')}`;
    const oid = repo.refs.get(ref);
    if (!oid) notFound();
    return json(200, refJson(ref, oid));
  }
  if (s[0] === 'commits' && n === 2 && method === 'GET') {
    const oid = s[1] as string;
    if (!repo.db.commit(oid)) notFound();
    return json(200, contentCommitJson(repo, oid, base));
  }
  if (s[0] === 'commits' && n === 1 && method === 'POST') {
    const b = obj(ctx.body);
    if (typeof b.tree !== 'string' || repo.db.get(b.tree)?.type !== 'tree') throw new ApiError(422, 'Tree SHA does not exist');
    const parents = Array.isArray(b.parents) ? b.parents.filter((p): p is string => typeof p === 'string') : [];
    for (const p of parents) if (!repo.db.commit(p)) throw new ApiError(422, 'Parent SHA does not exist or is not a commit object');
    const files = repo.db.flatten(b.tree);
    void files;
    const sec = store.nowSec();
    const ident = store.ident(sec);
    const message = typeof b.message === 'string' ? b.message : '';
    const data = Buffer.from(`tree ${b.tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${ident}\ncommitter ${ident}\n\n${message}`, 'utf8');
    const oid = repo.db.put('commit', data);
    return json(201, contentCommitJson(repo, oid, base));
  }
  if (s[0] === 'blobs' && n === 1 && method === 'POST') {
    const b = obj(ctx.body);
    if (typeof b.content !== 'string') throw new ApiError(422, 'Validation Failed');
    const data = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8');
    const oid = repo.db.put('blob', data);
    return json(201, { sha: oid, url: `${base}/api/v3/${repoPath}/git/blobs/${oid}` });
  }
  if (s[0] === 'blobs' && n === 2 && method === 'GET') {
    const o = repo.db.get(s[1] as string);
    if (!o || o.type !== 'blob') notFound();
    return json(200, { sha: s[1], node_id: nodeId('B', 0), size: o.data.length, url: `${base}/api/v3/${repoPath}/git/blobs/${s[1]}`, content: o.data.toString('base64'), encoding: 'base64' });
  }
  if (s[0] === 'trees' && n === 2 && method === 'GET') {
    const tip = resolveRef(repo, s[1]);
    let treeOid = s[1] as string;
    if (tip && repo.db.commit(tip)) treeOid = repo.db.commit(tip)!.tree;
    if (repo.db.get(treeOid)?.type !== 'tree') notFound();
    const recursive = ctx.query.has('recursive');
    const entries: Array<Record<string, unknown>> = [];
    const walk = (oid: string, prefix: string): void => {
      for (const e of repo.db.tree(oid) ?? []) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        const isTree = e.mode === '40000';
        const ent: Record<string, unknown> = { path, mode: isTree ? '040000' : e.mode, type: isTree ? 'tree' : e.mode === '160000' ? 'commit' : 'blob', sha: e.oid, url: `${base}/api/v3/${repoPath}/git/${isTree ? 'trees' : 'blobs'}/${e.oid}` };
        if (!isTree) ent.size = repo.db.get(e.oid)?.data.length ?? 0;
        entries.push(ent);
        if (isTree && recursive) walk(e.oid, path);
      }
    };
    walk(treeOid, '');
    return json(200, { sha: treeOid, url: `${base}/api/v3/${repoPath}/git/trees/${treeOid}`, tree: entries, truncated: false });
  }
  if (s[0] === 'trees' && n === 1 && method === 'POST') {
    const b = obj(ctx.body);
    const files = typeof b.base_tree === 'string' && repo.db.get(b.base_tree)?.type === 'tree' ? repo.db.flatten(b.base_tree) : new Map<string, { oid: string; mode: string }>();
    if (!Array.isArray(b.tree)) throw new ApiError(422, 'Validation Failed');
    for (const raw of b.tree) {
      const e = raw as Record<string, unknown>;
      if (typeof e.path !== 'string') throw new ApiError(422, 'Validation Failed');
      if (e.sha === null) {
        files.delete(e.path);
        continue;
      }
      let oid = typeof e.sha === 'string' ? e.sha : '';
      if (typeof e.content === 'string') oid = repo.db.put('blob', Buffer.from(e.content, 'utf8'));
      if (!isOid(oid) || !repo.db.has(oid)) throw new ApiError(422, 'Validation Failed');
      files.set(e.path, { oid, mode: typeof e.mode === 'string' ? e.mode.replace(/^0+/, '') || '100644' : '100644' });
    }
    const oid = repo.db.writeFlat(files);
    return json(201, { sha: oid, url: `${base}/api/v3/${repoPath}/git/trees/${oid}`, tree: [], truncated: false });
  }
  if (s[0] === 'tags' && n === 2 && method === 'GET') {
    const o = repo.db.get(s[1] as string);
    if (!o || o.type !== 'tag') notFound();
    const t = parseTag(o.data);
    return json(200, { sha: s[1], tag: t.tag, message: t.message, tagger: identJson(t.tagger), object: { sha: t.object, type: t.type } });
  }
  notFound();
}
