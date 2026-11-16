// The forge's operations, shared by REST, GraphQL and MCP so the three surfaces act on one store
// and give the same answers. Each operation either returns its result or throws an ApiError with the
// HTTP status GitHub would answer.

import { ZERO_OID, isOid } from './git.ts';
import { store, type Issue, type Repo } from './store.ts';

export class ApiError extends Error {
  status: number;
  errors?: unknown[];
  constructor(status: number, message: string, errors?: unknown[]) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// ------------------------------------------------------------------ repositories

export function createRepo(input: Record<string, unknown>): Repo {
  const name = input.name;
  if (typeof name !== 'string' || name.trim() === '') throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'missing_field', field: 'name' }]);
  const clean = name.trim().replace(/\.git$/, '');
  if (!NAME_RE.test(clean) || clean === '.' || clean === '..') throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
  if (store.repos.has(clean.toLowerCase())) {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  const visibility = input.visibility;
  const priv = typeof input.private === 'boolean' ? input.private : visibility === 'private' || visibility === 'internal';
  const repo = store.createRepo(clean, {
    description: typeof input.description === 'string' ? input.description : null,
    private: priv,
    defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
    hasIssues: input.has_issues !== false,
  });
  if (input.auto_init === true) {
    const files = new Map<string, { oid: string; mode: string }>();
    const readme = repo.db.put('blob', Buffer.from(`# ${repo.name}\n${repo.description ? `\n${repo.description}\n` : ''}`, 'utf8'));
    files.set('README.md', { oid: readme, mode: '100644' });
    const commit = store.writeCommit(repo, files, [], 'Initial commit');
    store.setRef(repo, `refs/heads/${repo.defaultBranch}`, commit);
  }
  return repo;
}

export function updateRepo(repo: Repo, input: Record<string, unknown>): Repo {
  if (typeof input.name === 'string' && input.name !== repo.name) {
    const clean = input.name.trim();
    if (!NAME_RE.test(clean)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'name' }]);
    if (store.repos.has(clean.toLowerCase()) && clean.toLowerCase() !== repo.name.toLowerCase()) throw new ApiError(422, 'name already exists on this account');
    store.repos.delete(repo.name.toLowerCase());
    repo.name = clean;
    store.repos.set(clean.toLowerCase(), repo);
  }
  if (typeof input.description === 'string' || input.description === null) repo.description = input.description as string | null;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (input.visibility === 'private') repo.private = true;
  if (input.visibility === 'public') repo.private = false;
  if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
  if (typeof input.default_branch === 'string' && input.default_branch !== '') {
    if (repo.refs.size > 0 && !repo.refs.has(`refs/heads/${input.default_branch}`)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
    repo.defaultBranch = input.default_branch;
  }
  repo.updatedAt = store.now();
  return repo;
}

// ------------------------------------------------------------------ refs

/** Resolve a ref-ish (branch, tag, full ref or sha) to a commit oid. */
export function resolveRef(repo: Repo, ref: string | undefined | null): string | undefined {
  const r = ref === undefined || ref === null || ref === '' ? repo.defaultBranch : ref;
  if (r.startsWith('refs/')) {
    const oid = repo.refs.get(r);
    return oid === undefined ? undefined : repo.db.peel(oid);
  }
  const branch = repo.refs.get(`refs/heads/${r}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${r}`);
  if (tag) return repo.db.peel(tag);
  if (isOid(r) && repo.db.has(r)) return repo.db.peel(r);
  if (/^[0-9a-f]{7,39}$/.test(r)) {
    for (const oid of repo.db.objects.keys()) if (oid.startsWith(r)) return repo.db.peel(oid);
  }
  return undefined;
}

export function createRef(repo: Repo, ref: unknown, sha: unknown): { ref: string; sha: string } {
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.split('/').length < 3) throw new ApiError(422, 'Reference name is not well-formed');
  if (typeof sha !== 'string' || !isOid(sha) || !repo.db.has(sha)) throw new ApiError(422, 'Object does not exist');
  if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
  store.setRef(repo, ref, sha);
  return { ref, sha };
}

export function updateRef(repo: Repo, ref: string, sha: unknown, force: boolean): { ref: string; sha: string } {
  const current = repo.refs.get(ref);
  if (!current) throw new ApiError(422, 'Reference does not exist');
  if (typeof sha !== 'string' || !isOid(sha) || !repo.db.has(sha)) throw new ApiError(422, 'Object does not exist');
  if (!force && !repo.db.isAncestor(current, sha)) throw new ApiError(422, 'Update is not a fast forward');
  store.setRef(repo, ref, sha);
  return { ref, sha };
}

export function deleteRef(repo: Repo, ref: string): void {
  if (!repo.refs.has(ref)) throw new ApiError(422, 'Reference does not exist');
  store.setRef(repo, ref, ZERO_OID);
}

// ------------------------------------------------------------------ contents

function cleanPath(path: string): string {
  return path.split('/').filter((p) => p !== '').join('/');
}

export interface ContentResult {
  path: string;
  blob: string;
  size: number;
  commit: string;
}

export function putContent(repo: Repo, rawPath: string, input: Record<string, unknown>): { created: boolean; result: ContentResult } {
  const path = cleanPath(rawPath);
  if (path === '') throw new ApiError(422, 'path is required');
  if (typeof input.message !== 'string') throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  if (typeof input.content !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (!tip && repo.refs.size > 0 && branch !== repo.defaultBranch) throw new ApiError(404, `Branch ${branch} not found`);
  const files = tip ? repo.db.flatten((repo.db.commit(tip) as { tree: string }).tree) : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(path);
  const sha = typeof input.sha === 'string' ? input.sha : undefined;
  if (existing) {
    if (sha === undefined) throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (sha !== existing.oid) throw new ApiError(409, `${path} does not match ${sha}`);
  } else if (sha !== undefined && sha !== '') {
    // A sha for a file that does not exist is stale.
    throw new ApiError(409, `${path} does not match ${sha}`);
  }
  // A path below an existing file, or a file where a directory is, is refused.
  for (const p of files.keys()) {
    if (p.startsWith(`${path}/`)) throw new ApiError(422, `${path} is a directory`);
    if (path.startsWith(`${p}/`)) throw new ApiError(422, `${p} is a file`);
  }
  const data = Buffer.from(input.content.replace(/\s+/g, ''), 'base64');
  const blob = repo.db.put('blob', data);
  files.set(path, { oid: blob, mode: existing?.mode ?? '100644' });
  const commit = store.writeCommit(repo, files, tip ? [tip] : [], input.message);
  store.setRef(repo, `refs/heads/${branch}`, commit);
  return { created: !existing, result: { path, blob, size: data.length, commit } };
}

export function deleteContent(repo: Repo, rawPath: string, input: Record<string, unknown>): ContentResult {
  const path = cleanPath(rawPath);
  if (typeof input.message !== 'string') throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (!tip) throw new ApiError(404, 'Not Found');
  const files = repo.db.flatten((repo.db.commit(tip) as { tree: string }).tree);
  const existing = files.get(path);
  if (!existing) throw new ApiError(404, 'Not Found');
  if (typeof input.sha !== 'string') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (input.sha !== existing.oid) throw new ApiError(409, `${path} does not match ${input.sha}`);
  files.delete(path);
  const commit = store.writeCommit(repo, files, [tip], input.message);
  store.setRef(repo, `refs/heads/${branch}`, commit);
  return { path, blob: existing.oid, size: 0, commit };
}

// ------------------------------------------------------------------ issues

function labelNames(repo: Repo, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : null;
    if (name === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
    const label = repo.labels.get(name.toLowerCase());
    if (!label) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'name', value: name, message: `label ${name} does not exist` }]);
    if (!out.includes(label.name)) out.push(label.name);
  }
  return out;
}

export function createIssue(repo: Repo, input: Record<string, unknown>): Issue {
  if (typeof input.title !== 'string' && typeof input.title !== 'number') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  const title = String(input.title);
  if (title.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  if (!repo.hasIssues) throw new ApiError(410, 'Issues are disabled for this repo');
  const labels = labelNames(repo, input.labels);
  const assignees = Array.isArray(input.assignees) ? input.assignees.filter((a): a is string => typeof a === 'string') : typeof input.assignee === 'string' ? [input.assignee] : [];
  return store.newIssue(repo, { title, body: typeof input.body === 'string' ? input.body : null, labels, assignees });
}

export function updateIssue(repo: Repo, issue: Issue, input: Record<string, unknown>): Issue {
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'title' }]);
    issue.title = input.title;
  }
  if (input.body !== undefined) issue.body = typeof input.body === 'string' ? input.body : null;
  if (input.labels !== undefined) issue.labels = labelNames(repo, input.labels);
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
    store.setIssueState(issue, input.state, typeof input.state_reason === 'string' ? input.state_reason : null);
  }
  issue.updatedAt = store.now();
  return issue;
}

export function addLabels(repo: Repo, issue: Issue, raw: unknown): void {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { labels?: unknown }).labels) ? (raw as { labels: unknown[] }).labels : null;
  if (list === null) throw new ApiError(422, 'Validation Failed');
  for (const name of labelNames(repo, list)) if (!issue.labels.includes(name)) issue.labels.push(name);
}

export function createLabel(repo: Repo, input: Record<string, unknown>) {
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  if (repo.labels.has(input.name.toLowerCase())) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  const color = typeof input.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.color) ? input.color.replace(/^#/, '').toLowerCase() : 'ededed';
  return store.addLabel(repo, input.name, color, typeof input.description === 'string' ? input.description : null);
}

// ------------------------------------------------------------------ pull requests

function branchName(repo: Repo, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let name = raw;
  const colon = name.indexOf(':');
  if (colon >= 0) name = name.slice(colon + 1);
  if (name.startsWith('refs/heads/')) name = name.slice(11);
  void repo;
  return name;
}

export function createPull(repo: Repo, input: Record<string, unknown>): Issue {
  const head = branchName(repo, input.head);
  const base = branchName(repo, input.base);
  if (head === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'head' }]);
  if (base === null) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'base' }]);
  const headSha = store.branchTip(repo, head);
  const baseSha = store.branchTip(repo, base);
  if (!headSha) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  if (!baseSha) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
  if (head === base) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }]);
  for (const i of repo.issues) {
    if (i.pull && i.state === 'open' && i.pull.head === head && i.pull.base === base) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${store.viewer.login}:${head}.` }]);
    }
  }
  let title = typeof input.title === 'string' ? input.title : '';
  if (title === '' && typeof input.issue !== 'number') title = head;
  return store.newIssue(repo, {
    title,
    body: typeof input.body === 'string' ? input.body : null,
    labels: [],
    pull: { head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, draft: input.draft === true },
  });
}

/** The live head/base tips of a pull (frozen once it is closed or merged). */
export function pullTips(repo: Repo, issue: Issue): { headSha: string; baseSha: string } {
  const p = issue.pull!;
  if (issue.state === 'open') {
    const h = store.branchTip(repo, p.head);
    const b = store.branchTip(repo, p.base);
    if (h) p.headSha = h;
    if (b) p.baseSha = b;
  }
  return { headSha: p.headSha, baseSha: p.baseSha };
}

type Flat = Map<string, { oid: string; mode: string }>;

function treeOf(repo: Repo, commit: string): Flat {
  const c = repo.db.commit(commit);
  return c ? repo.db.flatten(c.tree) : new Map();
}

/** Three-way merge of head into base at the tree level; null when a path conflicts. */
export function mergeTrees(repo: Repo, baseTip: string, headTip: string): Flat | null {
  const mb = repo.db.mergeBase(baseTip, headTip);
  const B = mb ? treeOf(repo, mb) : new Map() as Flat;
  const O = treeOf(repo, baseTip);
  const T = treeOf(repo, headTip);
  const out: Flat = new Map();
  const paths = new Set<string>([...B.keys(), ...O.keys(), ...T.keys()]);
  for (const p of paths) {
    const b = B.get(p)?.oid;
    const o = O.get(p);
    const t = T.get(p);
    const oo = o?.oid;
    const to = t?.oid;
    let pick: { oid: string; mode: string } | undefined;
    if (oo === to) pick = o;
    else if (b === oo) pick = t;
    else if (b === to) pick = o;
    else return null;
    if (pick) out.set(p, pick);
  }
  return out;
}

const mergeableCache = new Map<string, boolean>();

export function isMergeable(repo: Repo, issue: Issue): boolean {
  const { headSha, baseSha } = pullTips(repo, issue);
  const key = `${repo.id}:${baseSha}:${headSha}`;
  let v = mergeableCache.get(key);
  if (v === undefined) {
    v = mergeTrees(repo, baseSha, headSha) !== null;
    mergeableCache.set(key, v);
  }
  return v;
}

export function mergePull(repo: Repo, issue: Issue, input: Record<string, unknown>): { sha: string; message: string } {
  const p = issue.pull!;
  if (p.merged) throw new ApiError(405, 'Pull Request is not mergeable');
  if (issue.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  const { headSha, baseSha } = pullTips(repo, issue);
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== headSha) throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  const method = typeof input.merge_method === 'string' ? input.merge_method : 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'merge_method' }]);
  const merged = mergeTrees(repo, baseSha, headSha);
  if (merged === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const title = typeof input.commit_title === 'string' && input.commit_title !== '' ? input.commit_title : method === 'merge' ? `Merge pull request #${issue.number} from ${store.viewer.login}/${p.head}` : `${issue.title} (#${issue.number})`;
  const extra = typeof input.commit_message === 'string' ? input.commit_message : method === 'merge' ? issue.title : '';
  const message = extra === '' ? title : `${title}\n\n${extra}`;
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  const commit = store.writeCommit(repo, merged, parents, message);
  store.setRef(repo, `refs/heads/${p.base}`, commit);
  p.merged = true;
  p.mergeCommitSha = commit;
  p.mergedAt = store.now();
  store.setIssueState(issue, 'closed', 'completed');
  return { sha: commit, message: 'Pull Request successfully merged' };
}

// ------------------------------------------------------------------ diffs

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  patch: string;
  previousSha: string | null;
}

function lines(buf: Buffer | undefined): string[] {
  if (!buf || buf.length === 0) return [];
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line-level diff counts and a single-hunk-per-change unified patch. */
function lineDiff(a: string[], b: string[]): { add: number; del: number; patch: string } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let common = 0;
  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= 4_000_000) {
    // LCS length by DP over the differing middle.
    let prev = new Uint32Array(midB.length + 1);
    let cur = new Uint32Array(midB.length + 1);
    for (let i = 1; i <= midA.length; i += 1) {
      for (let j = 1; j <= midB.length; j += 1) {
        cur[j] = midA[i - 1] === midB[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
      }
      [prev, cur] = [cur, prev];
    }
    common = prev[midB.length] as number;
  }
  const del = midA.length - common;
  const add = midB.length - common;
  const ctxStart = Math.max(0, start - 3);
  const ctxEndA = Math.min(a.length, endA + 3);
  const ctxEndB = Math.min(b.length, endB + 3);
  const body: string[] = [];
  for (let i = ctxStart; i < start; i += 1) body.push(` ${a[i]}`);
  for (const l of midA) body.push(`-${l}`);
  for (const l of midB) body.push(`+${l}`);
  for (let i = endA; i < ctxEndA; i += 1) body.push(` ${a[i]}`);
  const lenA = ctxEndA - ctxStart;
  const lenB = ctxEndB - ctxStart;
  const header = `@@ -${lenA === 0 ? 0 : ctxStart + 1},${lenA} +${lenB === 0 ? 0 : ctxStart + 1},${lenB} @@`;
  return { add, del, patch: add + del === 0 ? '' : [header, ...body].join('\n') };
}

export function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string): FileChange[] {
  const A = fromCommit ? treeOf(repo, fromCommit) : new Map() as Flat;
  const B = treeOf(repo, toCommit);
  const paths = [...new Set([...A.keys(), ...B.keys()])].sort();
  const out: FileChange[] = [];
  for (const p of paths) {
    const a = A.get(p);
    const b = B.get(p);
    if (a && b && a.oid === b.oid) continue;
    const la = lines(a ? repo.db.get(a.oid)?.data : undefined);
    const lb = lines(b ? repo.db.get(b.oid)?.data : undefined);
    const d = lineDiff(la, lb);
    out.push({
      filename: p,
      status: !a ? 'added' : !b ? 'removed' : 'modified',
      additions: d.add,
      deletions: d.del,
      changes: d.add + d.del,
      sha: (b ?? a)!.oid,
      patch: d.patch,
      previousSha: a ? a.oid : null,
    });
  }
  return out;
}

export function pullFiles(repo: Repo, issue: Issue): FileChange[] {
  const { headSha, baseSha } = pullTips(repo, issue);
  const mb = repo.db.mergeBase(baseSha, headSha);
  return diffCommits(repo, mb, headSha);
}

/** Commits on head not on base (for /pulls/{n}/commits and the pull's commit count). */
export function pullCommits(repo: Repo, issue: Issue): string[] {
  const { headSha, baseSha } = pullTips(repo, issue);
  const out: string[] = [];
  const stack = [headSha];
  const seen = new Set<string>();
  while (stack.length) {
    const c = stack.pop() as string;
    if (seen.has(c)) continue;
    seen.add(c);
    if (repo.db.isAncestor(c, baseSha)) continue;
    out.push(c);
    const commit = repo.db.commit(c);
    if (commit) stack.push(...commit.parents);
  }
  return out.reverse();
}

/** Commits from `tip` following parents, newest first. */
export function logFrom(repo: Repo, tip: string, limit: number, path?: string): string[] {
  const out: string[] = [];
  const queue = [tip];
  const seen = new Set<string>();
  while (queue.length && out.length < limit) {
    // Order by committer time, newest first.
    queue.sort((x, y) => commitTime(repo, y) - commitTime(repo, x));
    const c = queue.shift() as string;
    if (seen.has(c)) continue;
    seen.add(c);
    const commit = repo.db.commit(c);
    if (!commit) continue;
    if (path === undefined || touches(repo, c, path)) out.push(c);
    queue.push(...commit.parents);
  }
  return out;
}

function commitTime(repo: Repo, oid: string): number {
  const c = repo.db.commit(oid);
  if (!c) return 0;
  const m = / (\d+) [+-]\d{4}$/.exec(c.committer);
  return m ? Number(m[1]) : 0;
}

function touches(repo: Repo, oid: string, path: string): boolean {
  const c = repo.db.commit(oid);
  if (!c) return false;
  const mine = repo.db.lookupPath(c.tree, path)?.oid;
  if (c.parents.length === 0) return mine !== undefined;
  for (const p of c.parents) {
    const pc = repo.db.commit(p);
    const theirs = pc ? repo.db.lookupPath(pc.tree, path)?.oid : undefined;
    if (theirs === mine) return false;
  }
  return true;
}
