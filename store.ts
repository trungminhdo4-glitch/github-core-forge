// The forge's whole state, in memory: one user (the token's), its repositories, and each
// repository's git objects, refs, labels, issues, pull requests and comments.
//
// Nothing reads the wall clock or Math.random: timestamps come from a logical clock that starts at
// MAKEFUN_TRIAL_NOW (or a fixed epoch) and advances one second per write, so a replayed trial makes
// the same objects with the same ids.

import { ObjectDB, ZERO_OID, serializeCommit, type Commit } from './git.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullInfo {
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  draft: boolean;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pull: PullInfo | null;
}

export interface Repo {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  db: ObjectDB;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  nextNumber: number;
  /** Bumped on every ref or object change: keys the fetch answer cache. */
  version: number;
}

function parseNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const n = Number(raw);
  if (raw !== '' && Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n);
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return Math.floor(t / 1000);
  return 1_735_689_600;
}

export class Store {
  viewer: User;
  /** Login learned from the first owner-bearing request when FORGE_LOGIN is unset. */
  loginKnown: boolean;
  repos = new Map<string, Repo>(); // lower-cased name → repo
  repoById = new Map<number, Repo>();
  private nextId = 1;
  private clock: number;

  constructor() {
    const login = process.env.FORGE_LOGIN ?? '';
    this.viewer = { id: 1, login, name: login, email: login === '' ? '' : `${login}@users.noreply.forge` };
    this.loginKnown = login !== '';
    this.clock = parseNow();
    this.nextId = 2;
  }

  /** The repository owner named in a path is the viewer: learn the login on first use. */
  ownerIs(owner: string): boolean {
    if (!this.loginKnown) {
      this.viewer.login = owner;
      this.viewer.name = owner;
      this.viewer.email = `${owner}@users.noreply.forge`;
      this.loginKnown = true;
      return true;
    }
    return owner.toLowerCase() === this.viewer.login.toLowerCase();
  }

  id(): number {
    return this.nextId++;
  }

  now(): string {
    this.clock += 1;
    return new Date(this.clock * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nowSec(): number {
    this.clock += 1;
    return this.clock;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (!this.ownerIs(owner)) return undefined;
    return this.repos.get(name.toLowerCase());
  }

  createRepo(name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string; hasIssues?: boolean }): Repo {
    const ts = this.now();
    const repo: Repo = {
      id: this.id(),
      name,
      description: opts.description ?? null,
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      hasIssues: opts.hasIssues ?? true,
      createdAt: ts,
      updatedAt: ts,
      pushedAt: null,
      db: new ObjectDB(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      nextNumber: 1,
      version: 0,
    };
    this.repos.set(name.toLowerCase(), repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name.toLowerCase());
    this.repoById.delete(repo.id);
  }

  ident(sec: number): string {
    const name = this.viewer.name || this.viewer.login || 'forge';
    const email = this.viewer.email || 'forge@users.noreply.forge';
    return `${name} <${email}> ${sec} +0000`;
  }

  /** Write a commit on top of `parent` with the flat file map; returns the commit oid. */
  writeCommit(repo: Repo, files: Map<string, { oid: string; mode: string }>, parents: string[], message: string): string {
    const tree = repo.db.writeFlat(files);
    const sec = this.nowSec();
    const ident = this.ident(sec);
    const c: Commit = { tree, parents, author: ident, committer: ident, message: message.endsWith('\n') ? message : `${message}\n` };
    return repo.db.put('commit', serializeCommit(c));
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.version += 1;
    if (oid === ZERO_OID) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
    repo.pushedAt = this.now();
    repo.updatedAt = repo.pushedAt;
    if (oid !== ZERO_OID && ref.startsWith('refs/heads/') && !repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
      repo.defaultBranch = ref.slice('refs/heads/'.length);
    }
  }

  newIssue(repo: Repo, fields: { title: string; body: string | null; labels: string[]; assignees?: string[]; pull?: PullInfo | null }): Issue {
    const ts = this.now();
    const issue: Issue = {
      id: this.id(),
      number: repo.nextNumber++,
      title: fields.title,
      body: fields.body,
      state: 'open',
      stateReason: null,
      labels: fields.labels,
      assignees: fields.assignees ?? [],
      comments: [],
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      pull: fields.pull ?? null,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  addLabel(repo: Repo, name: string, color: string, description: string | null): Label {
    const label: Label = { id: this.id(), name, color, description };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  addComment(issue: Issue, body: string): Comment {
    const ts = this.now();
    const c: Comment = { id: this.id(), body, createdAt: ts, updatedAt: ts };
    issue.comments.push(c);
    issue.updatedAt = ts;
    return c;
  }

  setIssueState(issue: Issue, state: 'open' | 'closed', reason: string | null = null): void {
    if (issue.state === state) return;
    issue.state = state;
    const ts = this.now();
    issue.updatedAt = ts;
    issue.closedAt = state === 'closed' ? ts : null;
    issue.stateReason = state === 'closed' ? (reason ?? 'completed') : (reason ?? 'reopened');
  }
}

export const store = new Store();
