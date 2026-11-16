// GitHub GraphQL v4 at /api/graphql: a small parser, a typed schema (which drives validation and
// introspection), and resolvers over the same store REST and MCP use.

import { nodeId } from './rest.ts';
import {
  ApiError, createIssue, createPull, isMergeable, mergePull, pullCommits, pullFiles, pullTips, updateIssue,
} from './ops.ts';
import { store, type Comment, type Issue, type Label, type Repo } from './store.ts';

// ================================================================== parser

type Value =
  | { k: 'var'; name: string }
  | { k: 'int' | 'float'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; v: Value[] }
  | { k: 'obj'; v: Array<[string, Value]> };

interface FieldNode { kind: 'field'; alias: string; name: string; args: Array<[string, Value]>; sel: Selection[] | null; loc: [number, number] }
interface FragSpread { kind: 'spread'; name: string }
interface InlineFrag { kind: 'inline'; on: string | null; sel: Selection[] }
type Selection = FieldNode | FragSpread | InlineFrag;
interface Operation { type: 'query' | 'mutation' | 'subscription'; name: string | null; vars: Array<{ name: string; type: string; def: Value | null }>; sel: Selection[] }
interface Fragment { name: string; on: string; sel: Selection[] }

class GqlError extends Error {
  locations?: Array<{ line: number; column: number }>;
  constructor(message: string, loc?: [number, number]) {
    super(message);
    if (loc) this.locations = [{ line: loc[0], column: loc[1] }];
  }
}

interface Tok { t: string; v: string; line: number; col: number }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === '\n') {
      line += 1;
      i += 1;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    const col = i - lineStart + 1;
    if (c === '.' && src.startsWith('...', i)) {
      out.push({ t: 'p', v: '...', line, col });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(c)) {
      out.push({ t: 'p', v: c, line, col });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('Unterminated block string', [line, col]);
        const raw = src.slice(i + 3, end);
        for (const ch of raw) if (ch === '\n') line += 1;
        out.push({ t: 's', v: blockString(raw), line, col });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\n') throw new GqlError('Unterminated string', [line, col]);
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'u') {
            s += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : (e as string);
          j += 2;
          continue;
        }
        s += src[j];
        j += 1;
      }
      if (j >= n) throw new GqlError('Unterminated string', [line, col]);
      out.push({ t: 's', v: s, line, col });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new GqlError(`Unexpected character "${c}"`, [line, col]);
      out.push({ t: m[1] || m[2] ? 'f' : 'i', v: m[0], line, col });
      i += m[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: 'n', v: m[0], line, col });
      i += m[0].length;
      continue;
    }
    throw new GqlError(`Parse error on "${c}"`, [line, col]);
  }
  out.push({ t: 'eof', v: '', line, col: i - lineStart + 1 });
  return out;
}

function blockString(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  let common = Infinity;
  for (let k = 1; k < lines.length; k += 1) {
    const l = lines[k] as string;
    const ind = l.length - l.trimStart().length;
    if (ind < l.length) common = Math.min(common, ind);
  }
  const res = lines.map((l, k) => (k === 0 || common === Infinity ? l : l.slice(common)));
  while (res.length && (res[0] as string).trim() === '') res.shift();
  while (res.length && (res[res.length - 1] as string).trim() === '') res.pop();
  return res.join('\n');
}

class Parser {
  toks: Tok[];
  p = 0;
  constructor(src: string) {
    this.toks = tokenize(src);
  }
  peek(): Tok {
    return this.toks[this.p] as Tok;
  }
  next(): Tok {
    return this.toks[this.p++] as Tok;
  }
  is(v: string): boolean {
    const t = this.peek();
    return t.t === 'p' && t.v === v;
  }
  expect(v: string): void {
    const t = this.next();
    if (t.t !== 'p' || t.v !== v) throw new GqlError(`Parse error on "${t.v || 'end of document'}" (expected "${v}")`, [t.line, t.col]);
  }
  name(): string {
    const t = this.next();
    if (t.t !== 'n') throw new GqlError(`Parse error on "${t.v || 'end of document'}" (expected a name)`, [t.line, t.col]);
    return t.v;
  }
  document(): { ops: Operation[]; frags: Map<string, Fragment> } {
    const ops: Operation[] = [];
    const frags = new Map<string, Fragment>();
    while (this.peek().t !== 'eof') {
      if (this.is('{')) {
        ops.push({ type: 'query', name: null, vars: [], sel: this.selectionSet() });
        continue;
      }
      const t = this.peek();
      if (t.t === 'n' && (t.v === 'query' || t.v === 'mutation' || t.v === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().t === 'n') name = this.name();
        const vars: Operation['vars'] = [];
        if (this.is('(')) {
          this.next();
          while (!this.is(')')) {
            this.expect('$');
            const vn = this.name();
            this.expect(':');
            const type = this.typeRef();
            let def: Value | null = null;
            if (this.is('=')) {
              this.next();
              def = this.value(true);
            }
            this.directives();
            vars.push({ name: vn, type, def });
          }
          this.next();
        }
        this.directives();
        ops.push({ type: t.v as Operation['type'], name, vars, sel: this.selectionSet() });
        continue;
      }
      if (t.t === 'n' && t.v === 'fragment') {
        this.next();
        const name = this.name();
        const on = this.name();
        if (on !== 'on') throw new GqlError('Expected "on"', [t.line, t.col]);
        const type = this.name();
        this.directives();
        frags.set(name, { name, on: type, sel: this.selectionSet() });
        continue;
      }
      throw new GqlError(`Parse error on "${t.v}"`, [t.line, t.col]);
    }
    return { ops, frags };
  }
  typeRef(): string {
    let s: string;
    if (this.is('[')) {
      this.next();
      s = `[${this.typeRef()}]`;
      this.expect(']');
    } else s = this.name();
    if (this.is('!')) {
      this.next();
      s += '!';
    }
    return s;
  }
  directives(): void {
    while (this.is('@')) {
      this.next();
      this.name();
      if (this.is('(')) this.args();
    }
  }
  selectionSet(): Selection[] {
    this.expect('{');
    const sel: Selection[] = [];
    while (!this.is('}')) {
      if (this.peek().t === 'eof') throw new GqlError('Parse error on end of document (expected "}")');
      if (this.is('...')) {
        this.next();
        const t = this.peek();
        if (t.t === 'n' && t.v === 'on') {
          this.next();
          const on = this.name();
          this.directives();
          sel.push({ kind: 'inline', on, sel: this.selectionSet() });
        } else if (this.is('{') || this.is('@')) {
          this.directives();
          sel.push({ kind: 'inline', on: null, sel: this.selectionSet() });
        } else {
          sel.push({ kind: 'spread', name: this.name() });
          this.directives();
        }
        continue;
      }
      const t = this.peek();
      let alias = this.name();
      let name = alias;
      if (this.is(':')) {
        this.next();
        name = this.name();
      }
      const args = this.is('(') ? this.args() : [];
      this.directives();
      const sub = this.is('{') ? this.selectionSet() : null;
      sel.push({ kind: 'field', alias, name, args, sel: sub, loc: [t.line, t.col] });
      alias = '';
    }
    this.next();
    return sel;
  }
  args(): Array<[string, Value]> {
    this.expect('(');
    const out: Array<[string, Value]> = [];
    while (!this.is(')')) {
      const n = this.name();
      this.expect(':');
      out.push([n, this.value(false)]);
    }
    this.next();
    return out;
  }
  value(isConst: boolean): Value {
    const t = this.next();
    if (t.t === 'p' && t.v === '$' && !isConst) return { k: 'var', name: this.name() };
    if (t.t === 'i') return { k: 'int', v: Number(t.v) };
    if (t.t === 'f') return { k: 'float', v: Number(t.v) };
    if (t.t === 's') return { k: 'str', v: t.v };
    if (t.t === 'n') {
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'null' };
      return { k: 'enum', v: t.v };
    }
    if (t.t === 'p' && t.v === '[') {
      const v: Value[] = [];
      while (!this.is(']')) v.push(this.value(isConst));
      this.next();
      return { k: 'list', v };
    }
    if (t.t === 'p' && t.v === '{') {
      const v: Array<[string, Value]> = [];
      while (!this.is('}')) {
        const n = this.name();
        this.expect(':');
        v.push([n, this.value(isConst)]);
      }
      this.next();
      return { k: 'obj', v };
    }
    throw new GqlError(`Parse error on "${t.v || 'end of document'}"`, [t.line, t.col]);
  }
}

// ================================================================== schema

interface FieldDef { type: string; args?: Record<string, string>; desc?: string }
interface TypeDef { kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'UNION'; fields?: Record<string, FieldDef>; values?: string[]; inputs?: Record<string, string>; interfaces?: string[]; possible?: string[]; desc?: string }

const conn = (node: string): Record<string, FieldDef> => ({
  nodes: { type: `[${node}]` },
  edges: { type: `[${node}Edge]` },
  pageInfo: { type: 'PageInfo!' },
  totalCount: { type: 'Int!' },
});
const edge = (node: string): Record<string, FieldDef> => ({ node: { type: node }, cursor: { type: 'String!' } });
const pageArgs = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

const issueFields: Record<string, FieldDef> = {
  id: { type: 'ID!' }, databaseId: { type: 'Int' }, number: { type: 'Int!' }, title: { type: 'String!' }, body: { type: 'String!' },
  bodyText: { type: 'String!' }, bodyHTML: { type: 'HTML!' }, state: { type: 'IssueState!' }, stateReason: { type: 'IssueStateReason' },
  closed: { type: 'Boolean!' }, closedAt: { type: 'DateTime' }, createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' },
  url: { type: 'URI!' }, resourcePath: { type: 'URI!' }, author: { type: 'Actor' }, editor: { type: 'Actor' }, locked: { type: 'Boolean!' },
  repository: { type: 'Repository!' }, labels: { type: 'LabelConnection', args: pageArgs }, comments: { type: 'IssueCommentConnection!', args: pageArgs },
  assignees: { type: 'UserConnection!', args: pageArgs }, milestone: { type: 'Milestone' }, authorAssociation: { type: 'CommentAuthorAssociation!' },
  viewerCanUpdate: { type: 'Boolean!' }, viewerCanClose: { type: 'Boolean!' }, viewerCanReopen: { type: 'Boolean!' }, isPinned: { type: 'Boolean' },
  projectCards: { type: 'ProjectCardConnection!', args: pageArgs }, projectItems: { type: 'ProjectV2ItemConnection!', args: pageArgs },
  reactionGroups: { type: '[ReactionGroup!]' }, trackedIssues: { type: 'IssueConnection!', args: pageArgs }, trackedInIssues: { type: 'IssueConnection!', args: pageArgs },
  closedByPullRequestsReferences: { type: 'PullRequestConnection', args: pageArgs }, issueType: { type: 'IssueType' }, parent: { type: 'Issue' },
  subIssues: { type: 'IssueConnection!', args: pageArgs }, lastEditedAt: { type: 'DateTime' }, publishedAt: { type: 'DateTime' }, titleHTML: { type: 'String!' },
  fullDatabaseId: { type: 'BigInt' },
};

const prFields: Record<string, FieldDef> = {
  id: { type: 'ID!' }, databaseId: { type: 'Int' }, number: { type: 'Int!' }, title: { type: 'String!' }, body: { type: 'String!' },
  bodyText: { type: 'String!' }, bodyHTML: { type: 'HTML!' }, state: { type: 'PullRequestState!' }, closed: { type: 'Boolean!' },
  closedAt: { type: 'DateTime' }, createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' }, url: { type: 'URI!' }, resourcePath: { type: 'URI!' },
  author: { type: 'Actor' }, headRefName: { type: 'String!' }, baseRefName: { type: 'String!' }, headRefOid: { type: 'GitObjectID!' },
  baseRefOid: { type: 'GitObjectID!' }, headRef: { type: 'Ref' }, baseRef: { type: 'Ref' }, headRepository: { type: 'Repository' },
  headRepositoryOwner: { type: 'RepositoryOwner' }, baseRepository: { type: 'Repository' }, repository: { type: 'Repository!' },
  isCrossRepository: { type: 'Boolean!' }, isDraft: { type: 'Boolean!' }, mergeable: { type: 'MergeableState!' }, merged: { type: 'Boolean!' },
  mergedAt: { type: 'DateTime' }, mergedBy: { type: 'Actor' }, mergeCommit: { type: 'Commit' }, mergeStateStatus: { type: 'MergeStateStatus!' },
  additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changedFiles: { type: 'Int!' }, files: { type: 'PullRequestChangedFileConnection', args: pageArgs },
  commits: { type: 'PullRequestCommitConnection!', args: pageArgs }, labels: { type: 'LabelConnection', args: pageArgs },
  comments: { type: 'IssueCommentConnection!', args: pageArgs }, assignees: { type: 'UserConnection!', args: pageArgs },
  reviewRequests: { type: 'ReviewRequestConnection', args: pageArgs }, reviews: { type: 'PullRequestReviewConnection', args: pageArgs },
  latestReviews: { type: 'PullRequestReviewConnection', args: pageArgs }, reviewDecision: { type: 'PullRequestReviewDecision' },
  milestone: { type: 'Milestone' }, locked: { type: 'Boolean!' }, maintainerCanModify: { type: 'Boolean!' }, authorAssociation: { type: 'CommentAuthorAssociation!' },
  autoMergeRequest: { type: 'AutoMergeRequest' }, statusCheckRollup: { type: 'StatusCheckRollup' }, projectCards: { type: 'ProjectCardConnection!', args: pageArgs },
  projectItems: { type: 'ProjectV2ItemConnection!', args: pageArgs }, reactionGroups: { type: '[ReactionGroup!]' }, viewerCanUpdate: { type: 'Boolean!' },
  viewerCanMergeAsAdmin: { type: 'Boolean!' }, viewerCanEnableAutoMerge: { type: 'Boolean!' }, viewerCanDisableAutoMerge: { type: 'Boolean!' },
  isInMergeQueue: { type: 'Boolean!' }, isMergeQueueEnabled: { type: 'Boolean!' }, potentialMergeCommit: { type: 'Commit' },
  closingIssuesReferences: { type: 'IssueConnection', args: pageArgs }, titleHTML: { type: 'HTML!' }, permalink: { type: 'URI!' },
  revertUrl: { type: 'URI!' }, totalCommentsCount: { type: 'Int' }, fullDatabaseId: { type: 'BigInt' }, lastEditedAt: { type: 'DateTime' },
};

const repoFields: Record<string, FieldDef> = {
  id: { type: 'ID!' }, databaseId: { type: 'Int' }, name: { type: 'String!' }, nameWithOwner: { type: 'String!' }, owner: { type: 'RepositoryOwner!' },
  description: { type: 'String' }, url: { type: 'URI!' }, sshUrl: { type: 'GitSSHRemote!' }, homepageUrl: { type: 'URI' }, isPrivate: { type: 'Boolean!' },
  visibility: { type: 'RepositoryVisibility!' }, isFork: { type: 'Boolean!' }, isArchived: { type: 'Boolean!' }, isEmpty: { type: 'Boolean!' },
  isTemplate: { type: 'Boolean!' }, isMirror: { type: 'Boolean!' }, isLocked: { type: 'Boolean!' }, isDisabled: { type: 'Boolean!' },
  isInOrganization: { type: 'Boolean!' }, isSecurityPolicyEnabled: { type: 'Boolean' }, isBlankIssuesEnabled: { type: 'Boolean!' }, isUserConfigurationRepository: { type: 'Boolean!' },
  defaultBranchRef: { type: 'Ref' }, viewerPermission: { type: 'RepositoryPermission' }, viewerCanAdminister: { type: 'Boolean!' },
  viewerCanCreateProjects: { type: 'Boolean!' }, viewerCanSubscribe: { type: 'Boolean!' }, viewerCanUpdateTopics: { type: 'Boolean!' },
  viewerHasStarred: { type: 'Boolean!' }, viewerDefaultMergeMethod: { type: 'PullRequestMergeMethod!' }, viewerDefaultCommitEmail: { type: 'String' },
  viewerPossibleCommitEmails: { type: '[String!]' }, viewerSubscription: { type: 'SubscriptionState' },
  hasIssuesEnabled: { type: 'Boolean!' }, hasWikiEnabled: { type: 'Boolean!' }, hasProjectsEnabled: { type: 'Boolean!' }, hasDiscussionsEnabled: { type: 'Boolean!' },
  mergeCommitAllowed: { type: 'Boolean!' }, squashMergeAllowed: { type: 'Boolean!' }, rebaseMergeAllowed: { type: 'Boolean!' }, autoMergeAllowed: { type: 'Boolean!' },
  deleteBranchOnMerge: { type: 'Boolean!' }, forkingAllowed: { type: 'Boolean!' }, forkCount: { type: 'Int!' }, stargazerCount: { type: 'Int!' },
  createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' }, pushedAt: { type: 'DateTime' }, diskUsage: { type: 'Int' },
  parent: { type: 'Repository' }, templateRepository: { type: 'Repository' }, primaryLanguage: { type: 'Language' }, licenseInfo: { type: 'License' },
  issue: { type: 'Issue', args: { number: 'Int!' } }, issueOrPullRequest: { type: 'IssueOrPullRequest', args: { number: 'Int!' } },
  issues: { type: 'IssueConnection!', args: { ...pageArgs, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' } },
  pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
  pullRequests: { type: 'PullRequestConnection!', args: { ...pageArgs, states: '[PullRequestState!]', orderBy: 'IssueOrder', labels: '[String!]', headRefName: 'String', baseRefName: 'String' } },
  labels: { type: 'LabelConnection', args: { ...pageArgs, query: 'String', orderBy: 'LabelOrder' } }, label: { type: 'Label', args: { name: 'String!' } },
  ref: { type: 'Ref', args: { qualifiedName: 'String!' } }, refs: { type: 'RefConnection', args: { ...pageArgs, refPrefix: 'String!', query: 'String' } },
  object: { type: 'GitObject', args: { oid: 'GitObjectID', expression: 'String' } }, assignableUsers: { type: 'UserConnection!', args: { ...pageArgs, query: 'String' } },
  mentionableUsers: { type: 'UserConnection!', args: { ...pageArgs, query: 'String' } }, milestones: { type: 'MilestoneConnection', args: pageArgs },
  repositoryTopics: { type: 'RepositoryTopicConnection!', args: pageArgs }, languages: { type: 'LanguageConnection', args: pageArgs },
  securityPolicyUrl: { type: 'URI' }, squashMergeCommitTitle: { type: 'SquashMergeCommitTitle' }, squashMergeCommitMessage: { type: 'SquashMergeCommitMessage' },
  mergeCommitTitle: { type: 'MergeCommitTitle' }, mergeCommitMessage: { type: 'MergeCommitMessage' }, openGraphImageUrl: { type: 'URI!' },
  usesCustomOpenGraphImage: { type: 'Boolean!' }, watchers: { type: 'UserConnection!', args: pageArgs }, stargazers: { type: 'StargazerConnection!', args: pageArgs },
  resourcePath: { type: 'URI!' },
};

const userFields: Record<string, FieldDef> = {
  id: { type: 'ID!' }, databaseId: { type: 'Int' }, login: { type: 'String!' }, name: { type: 'String' }, email: { type: 'String!' },
  url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, bio: { type: 'String' }, company: { type: 'String' }, location: { type: 'String' },
  createdAt: { type: 'DateTime!' }, isSiteAdmin: { type: 'Boolean!' }, resourcePath: { type: 'URI!' },
  repositories: { type: 'RepositoryConnection!', args: { ...pageArgs, ownerAffiliations: '[RepositoryAffiliation]', orderBy: 'RepositoryOrder', privacy: 'RepositoryPrivacy' } },
  repository: { type: 'Repository', args: { name: 'String!' } }, organizations: { type: 'OrganizationConnection!', args: pageArgs },
};

const T: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT', fields: {
      viewer: { type: 'User!' }, repository: { type: 'Repository', args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' } },
      repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' } }, user: { type: 'User', args: { login: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } }, nodes: { type: '[Node]!', args: { ids: '[ID!]!' } },
      search: { type: 'SearchResultItemConnection!', args: { ...pageArgs, query: 'String!', type: 'SearchType!' } }, rateLimit: { type: 'RateLimit', args: { dryRun: 'Boolean' } },
      organization: { type: 'Organization', args: { login: 'String!' } },
    },
  },
  Mutation: {
    kind: 'OBJECT', fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } }, closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      reopenIssue: { type: 'ReopenIssuePayload', args: { input: 'ReopenIssueInput!' } }, updateIssue: { type: 'UpdateIssuePayload', args: { input: 'UpdateIssueInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } }, createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } }, closePullRequest: { type: 'ClosePullRequestPayload', args: { input: 'ClosePullRequestInput!' } },
      reopenPullRequest: { type: 'ReopenPullRequestPayload', args: { input: 'ReopenPullRequestInput!' } }, updatePullRequest: { type: 'UpdatePullRequestPayload', args: { input: 'UpdatePullRequestInput!' } },
      addLabelsToLabelable: { type: 'AddLabelsToLabelablePayload', args: { input: 'AddLabelsToLabelableInput!' } },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } }, possible: ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label', 'Ref', 'Commit'] },
  RepositoryOwner: { kind: 'INTERFACE', fields: { id: { type: 'ID!' }, login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, resourcePath: { type: 'URI!' }, repository: { type: 'Repository', args: { name: 'String!' } }, repositories: userFields.repositories as FieldDef }, possible: ['User', 'Organization'] },
  Actor: { kind: 'INTERFACE', fields: { login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, resourcePath: { type: 'URI!' } }, possible: ['User', 'Bot'] },
  GitObject: { kind: 'INTERFACE', fields: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' }, abbreviatedOid: { type: 'String!' }, url: { type: 'URI!' } }, possible: ['Commit'] },
  IssueOrPullRequest: { kind: 'UNION', possible: ['Issue', 'PullRequest'] },
  SearchResultItem: { kind: 'UNION', possible: ['Issue', 'PullRequest', 'Repository', 'User'] },
  User: { kind: 'OBJECT', interfaces: ['Node', 'Actor', 'RepositoryOwner'], fields: userFields },
  Organization: { kind: 'OBJECT', interfaces: ['Node', 'Actor', 'RepositoryOwner'], fields: { id: { type: 'ID!' }, login: { type: 'String!' }, name: { type: 'String' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, resourcePath: { type: 'URI!' }, repository: { type: 'Repository', args: { name: 'String!' } }, repositories: userFields.repositories as FieldDef } },
  Bot: { kind: 'OBJECT', interfaces: ['Node', 'Actor'], fields: { id: { type: 'ID!' }, login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, resourcePath: { type: 'URI!' } } },
  Repository: { kind: 'OBJECT', interfaces: ['Node'], fields: repoFields },
  Issue: { kind: 'OBJECT', interfaces: ['Node'], fields: issueFields },
  PullRequest: { kind: 'OBJECT', interfaces: ['Node'], fields: prFields },
  IssueComment: { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!' }, databaseId: { type: 'Int' }, body: { type: 'String!' }, bodyText: { type: 'String!' }, bodyHTML: { type: 'HTML!' }, author: { type: 'Actor' }, createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' }, url: { type: 'URI!' }, issue: { type: 'Issue!' }, pullRequest: { type: 'PullRequest' }, authorAssociation: { type: 'CommentAuthorAssociation!' }, viewerDidAuthor: { type: 'Boolean!' }, isMinimized: { type: 'Boolean!' }, reactionGroups: { type: '[ReactionGroup!]' } } },
  Label: { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!' }, name: { type: 'String!' }, color: { type: 'String!' }, description: { type: 'String' }, isDefault: { type: 'Boolean!' }, url: { type: 'URI!' } } },
  Ref: { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!' }, name: { type: 'String!' }, prefix: { type: 'String!' }, target: { type: 'GitObject' }, repository: { type: 'Repository!' } } },
  Commit: { kind: 'OBJECT', interfaces: ['Node', 'GitObject'], fields: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' }, abbreviatedOid: { type: 'String!' }, message: { type: 'String!' }, messageHeadline: { type: 'String!' }, messageBody: { type: 'String!' }, committedDate: { type: 'DateTime!' }, authoredDate: { type: 'DateTime!' }, url: { type: 'URI!' }, author: { type: 'GitActor' }, committer: { type: 'GitActor' }, history: { type: 'CommitHistoryConnection!', args: pageArgs } } },
  GitActor: { kind: 'OBJECT', fields: { name: { type: 'String' }, email: { type: 'String' }, date: { type: 'GitTimestamp' }, user: { type: 'User' } } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!' }, viewerViewedState: { type: 'FileViewedState!' } } },
  PullRequestCommit: { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!' }, commit: { type: 'Commit!' }, url: { type: 'URI!' } } },
  PageInfo: { kind: 'OBJECT', fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } } },
  RateLimit: { kind: 'OBJECT', fields: { limit: { type: 'Int!' }, cost: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, resetAt: { type: 'DateTime!' }, nodeCount: { type: 'Int!' } } },
  SearchResultItemConnection: { kind: 'OBJECT', fields: { nodes: { type: '[SearchResultItem]' }, edges: { type: '[SearchResultItemEdge]' }, pageInfo: { type: 'PageInfo!' }, issueCount: { type: 'Int!' }, repositoryCount: { type: 'Int!' }, userCount: { type: 'Int!' }, discussionCount: { type: 'Int!' }, codeCount: { type: 'Int!' }, wikiCount: { type: 'Int!' } } },
  SearchResultItemEdge: { kind: 'OBJECT', fields: { node: { type: 'SearchResultItem' }, cursor: { type: 'String!' }, textMatches: { type: '[TextMatch]' } } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  UpdateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, actor: { type: 'Actor' }, clientMutationId: { type: 'String' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, timelineEdge: { type: 'IssueTimelineItemEdge' }, clientMutationId: { type: 'String' } } },
  IssueTimelineItemEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, actor: { type: 'Actor' }, clientMutationId: { type: 'String' } } },
  ClosePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  ReopenPullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  UpdatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, actor: { type: 'Actor' }, clientMutationId: { type: 'String' } } },
  AddLabelsToLabelablePayload: { kind: 'OBJECT', fields: { labelable: { type: 'Node' }, clientMutationId: { type: 'String' } } },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputs: { repositoryId: 'ID!', title: 'String!', body: 'String', assigneeIds: '[ID!]', labelIds: '[ID!]', milestoneId: 'ID', projectIds: '[ID!]', issueTemplate: 'String', issueTypeId: 'ID', parentIssueId: 'ID', clientMutationId: 'String' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputs: { issueId: 'ID!', stateReason: 'IssueClosedStateReason', duplicateIssueId: 'ID', clientMutationId: 'String' } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputs: { issueId: 'ID!', clientMutationId: 'String' } },
  UpdateIssueInput: { kind: 'INPUT_OBJECT', inputs: { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', assigneeIds: '[ID!]', labelIds: '[ID!]', milestoneId: 'ID', clientMutationId: 'String' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputs: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', inputs: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', headRepositoryId: 'ID', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', clientMutationId: 'String' } },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputs: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', authorEmail: 'String', clientMutationId: 'String' } },
  ClosePullRequestInput: { kind: 'INPUT_OBJECT', inputs: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  ReopenPullRequestInput: { kind: 'INPUT_OBJECT', inputs: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  UpdatePullRequestInput: { kind: 'INPUT_OBJECT', inputs: { pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestUpdateState', clientMutationId: 'String' } },
  AddLabelsToLabelableInput: { kind: 'INPUT_OBJECT', inputs: { labelableId: 'ID!', labelIds: '[ID!]!', clientMutationId: 'String' } },
  IssueOrder: { kind: 'INPUT_OBJECT', inputs: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  IssueFilters: { kind: 'INPUT_OBJECT', inputs: { assignee: 'String', createdBy: 'String', labels: '[String!]', mentioned: 'String', milestone: 'String', since: 'DateTime', states: '[IssueState!]', viewerSubscribed: 'Boolean' } },
  RepositoryOrder: { kind: 'INPUT_OBJECT', inputs: { field: 'RepositoryOrderField!', direction: 'OrderDirection!' } },
  LabelOrder: { kind: 'INPUT_OBJECT', inputs: { field: 'LabelOrderField!', direction: 'OrderDirection!' } },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  IssueStateReason: { kind: 'ENUM', values: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'] },
  IssueClosedStateReason: { kind: 'ENUM', values: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestUpdateState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeStateStatus: { kind: 'ENUM', values: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  RepositoryVisibility: { kind: 'ENUM', values: ['PRIVATE', 'PUBLIC', 'INTERNAL'] },
  RepositoryPrivacy: { kind: 'ENUM', values: ['PRIVATE', 'PUBLIC'] },
  RepositoryAffiliation: { kind: 'ENUM', values: ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'] },
  RepositoryOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'PUSHED_AT', 'NAME', 'STARGAZERS'] },
  LabelOrderField: { kind: 'ENUM', values: ['NAME', 'CREATED_AT'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  PatchStatus: { kind: 'ENUM', values: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'] },
  CommentAuthorAssociation: { kind: 'ENUM', values: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] },
  FileViewedState: { kind: 'ENUM', values: ['VIEWED', 'UNVIEWED', 'DISMISSED'] },
  PullRequestReviewDecision: { kind: 'ENUM', values: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] },
  SubscriptionState: { kind: 'ENUM', values: ['SUBSCRIBED', 'UNSUBSCRIBED', 'IGNORED'] },
};
for (const name of ['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'URI', 'HTML', 'GitObjectID', 'GitSSHRemote', 'GitTimestamp', 'BigInt']) T[name] = { kind: 'SCALAR' };
for (const [name, node] of [['Issue', 'Issue'], ['PullRequest', 'PullRequest'], ['Label', 'Label'], ['IssueComment', 'IssueComment'], ['User', 'User'], ['Repository', 'Repository'], ['PullRequestChangedFile', 'PullRequestChangedFile'], ['PullRequestCommit', 'PullRequestCommit'], ['Ref', 'Ref'], ['CommitHistory', 'Commit']] as const) {
  T[`${name}Connection`] = { kind: 'OBJECT', fields: conn(node) };
  T[`${name}Edge`] = { kind: 'OBJECT', fields: edge(node) };
}
// Types gh probes or selects whose content this forge never holds: empty connections.
for (const name of ['Milestone', 'ProjectCard', 'ProjectV2Item', 'ReviewRequest', 'PullRequestReview', 'Organization', 'RepositoryTopic', 'Language', 'Stargazer', 'TextMatch', 'IssueType', 'License', 'ReactionGroup', 'AutoMergeRequest', 'StatusCheckRollup', 'SquashMergeCommitTitle', 'SquashMergeCommitMessage', 'MergeCommitTitle', 'MergeCommitMessage']) {
  if (!T[name]) T[name] = { kind: 'OBJECT', fields: { id: { type: 'ID!' }, name: { type: 'String' } } };
  if (!T[`${name}Connection`]) T[`${name}Connection`] = { kind: 'OBJECT', fields: { ...conn(name) } };
  if (!T[`${name}Edge`]) T[`${name}Edge`] = { kind: 'OBJECT', fields: edge(name) };
}
for (const name of ['SquashMergeCommitTitle', 'SquashMergeCommitMessage', 'MergeCommitTitle', 'MergeCommitMessage']) T[name] = { kind: 'ENUM', values: ['PR_TITLE', 'PR_BODY', 'COMMIT_MESSAGES', 'BLANK', 'MERGE_MESSAGE', 'COMMIT_OR_PR_TITLE'] };

function baseType(t: string): string {
  return t.replace(/[[\]!]/g, '');
}

function implementsType(concrete: string, cond: string): boolean {
  if (concrete === cond) return true;
  const def = T[cond];
  if (def && (def.kind === 'INTERFACE' || def.kind === 'UNION')) return (def.possible ?? []).includes(concrete);
  return false;
}

// ================================================================== values

interface Obj { t: string; v: unknown }
const wrap = (t: string, v: unknown): Obj | null => (v === null || v === undefined ? null : { t, v });

interface RepoRef { repo: Repo }
interface IssueRef { repo: Repo; issue: Issue }
interface CommentRef { repo: Repo; issue: Issue; c: Comment }
interface LabelRef { repo: Repo; label: Label }
interface RefRef { repo: Repo; name: string; oid: string }
interface CommitRef { repo: Repo; oid: string }

const BASE = { url: 'http://localhost' };

function decodeId(id: unknown): { prefix: string; id: number } | null {
  if (typeof id !== 'string') return null;
  const m = /^([A-Z]+)_(.+)$/.exec(id);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[2] as string, 'base64url').toString('utf8');
    const mm = /^forge:([A-Z]+):(\d+)$/.exec(decoded);
    if (!mm || mm[1] !== m[1]) return null;
    return { prefix: m[1] as string, id: Number(mm[2]) };
  } catch {
    return null;
  }
}

function findIssueById(id: number): IssueRef | null {
  for (const repo of store.repos.values()) for (const issue of repo.issues) if (issue.id === id) return { repo, issue };
  return null;
}

function nodeById(id: unknown): Obj | null {
  const d = decodeId(id);
  if (!d) return null;
  if (d.prefix === 'R') {
    const repo = store.repoById.get(d.id);
    return repo && store.repos.get(repo.name.toLowerCase()) === repo ? { t: 'Repository', v: { repo } } : null;
  }
  if (d.prefix === 'I' || d.prefix === 'PR') {
    const f = findIssueById(d.id);
    if (!f) return null;
    if ((d.prefix === 'PR') !== (f.issue.pull !== null)) return null;
    return { t: f.issue.pull ? 'PullRequest' : 'Issue', v: f };
  }
  if (d.prefix === 'U') return d.id === store.viewer.id ? { t: 'User', v: {} } : null;
  if (d.prefix === 'IC') {
    for (const repo of store.repos.values()) for (const issue of repo.issues) for (const c of issue.comments) if (c.id === d.id) return { t: 'IssueComment', v: { repo, issue, c } };
    return null;
  }
  if (d.prefix === 'LA') {
    for (const repo of store.repos.values()) for (const label of repo.labels.values()) if (label.id === d.id) return { t: 'Label', v: { repo, label } };
  }
  return null;
}

function cursorOf(i: number): string {
  return Buffer.from(`cursor:${i}`).toString('base64');
}

function cursorIndex(c: unknown): number {
  if (typeof c !== 'string') return -1;
  const m = /^cursor:(\d+)$/.exec(Buffer.from(c, 'base64').toString('utf8'));
  return m ? Number(m[1]) : -1;
}

/** A Relay connection over an in-memory list. */
function connection(t: string, items: unknown[], args: Record<string, unknown>, extra: Record<string, unknown> = {}): Obj {
  let start = 0;
  let end = items.length;
  const after = cursorIndex(args.after);
  if (after >= 0) start = after + 1;
  const before = cursorIndex(args.before);
  if (before >= 0) end = Math.min(end, before);
  if (typeof args.first === 'number') end = Math.min(end, start + Math.max(0, args.first));
  if (typeof args.last === 'number') start = Math.max(start, end - Math.max(0, args.last));
  const slice: Array<{ node: unknown; cursor: string }> = [];
  for (let i = start; i < end; i += 1) slice.push({ node: items[i], cursor: cursorOf(i) });
  return {
    t,
    v: {
      list: slice,
      total: items.length,
      pageInfo: { hasNextPage: end < items.length, hasPreviousPage: start > 0, startCursor: slice[0]?.cursor ?? null, endCursor: slice[slice.length - 1]?.cursor ?? null },
      ...extra,
    },
  };
}

function nodeTypeOf(connType: string): string {
  const f = T[connType]?.fields?.nodes;
  return f ? baseType(f.type) : 'Node';
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return { t: issue.pull ? 'PullRequest' : 'Issue', v: { repo, issue } };
}

function sortIssues(list: Issue[], orderBy: unknown): Issue[] {
  const o = (orderBy ?? {}) as { field?: string; direction?: string };
  const field = o.field ?? 'CREATED_AT';
  const dir = o.direction ?? 'ASC';
  const key = (i: Issue): string => (field === 'UPDATED_AT' ? i.updatedAt : field === 'COMMENTS' ? String(i.comments.length).padStart(8, '0') : i.createdAt);
  const sorted = [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.number - b.number;
  });
  if (dir === 'DESC') sorted.reverse();
  return sorted;
}

function ownerOk(login: unknown): boolean {
  return typeof login === 'string' && store.ownerIs(login);
}

function prState(issue: Issue): string {
  if (issue.pull?.merged) return 'MERGED';
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function webUrl(path: string): string {
  return `${BASE.url}/${path}`;
}

function userObj(): Obj {
  return { t: 'User', v: {} };
}

// ================================================================== resolvers

type Resolver = (parent: unknown, args: Record<string, unknown>) => unknown;

const R: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(),
    repository: (_p, a) => {
      if (!ownerOk(a.owner)) return null;
      const repo = store.getRepo(a.owner as string, String(a.name));
      return repo ? { t: 'Repository', v: { repo } } : null;
    },
    repositoryOwner: (_p, a) => (ownerOk(a.login) ? userObj() : null),
    user: (_p, a) => (ownerOk(a.login) ? userObj() : null),
    organization: () => null,
    node: (_p, a) => nodeById(a.id),
    nodes: (_p, a) => (Array.isArray(a.ids) ? a.ids.map((id) => nodeById(id)) : []),
    rateLimit: () => ({ t: 'RateLimit', v: {} }),
    search: (_p, a) => {
      const q = String(a.query ?? '');
      const type = String(a.type ?? 'ISSUE');
      if (type === 'REPOSITORY') {
        const words = q.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(':'));
        const repos = [...store.repos.values()].filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
        return connection('SearchResultItemConnection', repos.map((repo) => ({ t: 'Repository', v: { repo } })), a, { repositoryCount: repos.length, issueCount: 0 });
      }
      const items = searchIssueItems(q);
      return connection('SearchResultItemConnection', items, a, { issueCount: items.length, repositoryCount: 0 });
    },
  },
  Mutation: {
    createIssue: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const node = nodeById(input.repositoryId);
      if (!node || node.t !== 'Repository') throw new GqlError(`Could not resolve to a node with the global id of '${String(input.repositoryId)}'`);
      const repo = (node.v as RepoRef).repo;
      const labels = Array.isArray(input.labelIds) ? input.labelIds.map((id) => nodeById(id)).filter((n): n is Obj => n?.t === 'Label').map((n) => (n.v as LabelRef).label.name) : [];
      const issue = createIssue(repo, { title: input.title, body: input.body, labels });
      return { t: 'CreateIssuePayload', v: { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null } };
    },
    closeIssue: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needIssueNode(input.issueId);
      store.setIssueState(f.issue, 'closed', typeof input.stateReason === 'string' ? input.stateReason.toLowerCase() : 'completed');
      return { t: 'CloseIssuePayload', v: { issue: issueObj(f.repo, f.issue), clientMutationId: input.clientMutationId ?? null } };
    },
    reopenIssue: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needIssueNode(input.issueId);
      store.setIssueState(f.issue, 'open', 'reopened');
      return { t: 'ReopenIssuePayload', v: { issue: issueObj(f.repo, f.issue), clientMutationId: input.clientMutationId ?? null } };
    },
    updateIssue: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needIssueNode(input.id);
      updateIssue(f.repo, f.issue, { title: input.title, body: input.body, state: typeof input.state === 'string' ? input.state.toLowerCase() : undefined });
      return { t: 'UpdateIssuePayload', v: { issue: issueObj(f.repo, f.issue), actor: userObj(), clientMutationId: input.clientMutationId ?? null } };
    },
    addComment: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const node = nodeById(input.subjectId);
      if (!node || (node.t !== 'Issue' && node.t !== 'PullRequest')) throw new GqlError(`Could not resolve to a node with the global id of '${String(input.subjectId)}'`);
      const f = node.v as IssueRef;
      if (typeof input.body !== 'string' || input.body === '') throw new GqlError('Body cannot be blank');
      const c = store.addComment(f.issue, input.body);
      const cObj = { t: 'IssueComment', v: { repo: f.repo, issue: f.issue, c } };
      return { t: 'AddCommentPayload', v: { commentEdge: { t: 'IssueCommentEdge', v: { node: cObj, cursor: cursorOf(f.issue.comments.length - 1) } }, timelineEdge: { t: 'IssueTimelineItemEdge', v: { node: cObj, cursor: cursorOf(0) } }, subject: node, clientMutationId: input.clientMutationId ?? null } };
    },
    createPullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const node = nodeById(input.repositoryId);
      if (!node || node.t !== 'Repository') throw new GqlError(`Could not resolve to a node with the global id of '${String(input.repositoryId)}'`);
      const repo = (node.v as RepoRef).repo;
      const issue = createPull(repo, { head: input.headRefName, base: input.baseRefName, title: input.title, body: input.body, draft: input.draft });
      return { t: 'CreatePullRequestPayload', v: { pullRequest: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null } };
    },
    mergePullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needPullNode(input.pullRequestId);
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      mergePull(f.repo, f.issue, { merge_method: method, commit_title: input.commitHeadline, commit_message: input.commitBody, sha: input.expectedHeadOid });
      return { t: 'MergePullRequestPayload', v: { pullRequest: issueObj(f.repo, f.issue), actor: userObj(), clientMutationId: input.clientMutationId ?? null } };
    },
    closePullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needPullNode(input.pullRequestId);
      if (!f.issue.pull!.merged) store.setIssueState(f.issue, 'closed');
      return { t: 'ClosePullRequestPayload', v: { pullRequest: issueObj(f.repo, f.issue), clientMutationId: input.clientMutationId ?? null } };
    },
    reopenPullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needPullNode(input.pullRequestId);
      if (!f.issue.pull!.merged) store.setIssueState(f.issue, 'open');
      return { t: 'ReopenPullRequestPayload', v: { pullRequest: issueObj(f.repo, f.issue), clientMutationId: input.clientMutationId ?? null } };
    },
    updatePullRequest: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const f = needPullNode(input.pullRequestId);
      updateIssue(f.repo, f.issue, { title: input.title, body: input.body, state: typeof input.state === 'string' ? input.state.toLowerCase() : undefined });
      if (typeof input.baseRefName === 'string' && store.branchTip(f.repo, input.baseRefName)) f.issue.pull!.base = input.baseRefName;
      return { t: 'UpdatePullRequestPayload', v: { pullRequest: issueObj(f.repo, f.issue), actor: userObj(), clientMutationId: input.clientMutationId ?? null } };
    },
    addLabelsToLabelable: (_p, a) => {
      const input = (a.input ?? {}) as Record<string, unknown>;
      const node = nodeById(input.labelableId);
      if (!node || (node.t !== 'Issue' && node.t !== 'PullRequest')) throw new GqlError(`Could not resolve to a node with the global id of '${String(input.labelableId)}'`);
      const f = node.v as IssueRef;
      for (const id of Array.isArray(input.labelIds) ? input.labelIds : []) {
        const l = nodeById(id);
        if (l?.t === 'Label' && !f.issue.labels.includes((l.v as LabelRef).label.name)) f.issue.labels.push((l.v as LabelRef).label.name);
      }
      return { t: 'AddLabelsToLabelablePayload', v: { labelable: node, clientMutationId: input.clientMutationId ?? null } };
    },
  },
  User: {
    id: () => nodeId('U', store.viewer.id),
    databaseId: () => store.viewer.id,
    login: () => store.viewer.login,
    name: () => store.viewer.name,
    email: () => store.viewer.email,
    url: () => webUrl(store.viewer.login),
    resourcePath: () => `/${store.viewer.login}`,
    avatarUrl: () => `${BASE.url}/avatars/${store.viewer.login}`,
    createdAt: () => '2020-01-01T00:00:00Z',
    isSiteAdmin: () => false,
    repositories: (_p, a) => connection('RepositoryConnection', [...store.repos.values()].sort((x, y) => x.id - y.id).map((repo) => ({ t: 'Repository', v: { repo } })), a),
    repository: (_p, a) => {
      const repo = store.repos.get(String(a.name).toLowerCase());
      return repo ? { t: 'Repository', v: { repo } } : null;
    },
    organizations: (_p, a) => connection('OrganizationConnection', [], a),
  },
  Repository: {
    id: (p) => nodeId('R', (p as RepoRef).repo.id),
    databaseId: (p) => (p as RepoRef).repo.id,
    name: (p) => (p as RepoRef).repo.name,
    nameWithOwner: (p) => `${store.viewer.login}/${(p as RepoRef).repo.name}`,
    owner: () => userObj(),
    description: (p) => (p as RepoRef).repo.description,
    url: (p) => webUrl(`${store.viewer.login}/${(p as RepoRef).repo.name}`),
    resourcePath: (p) => `/${store.viewer.login}/${(p as RepoRef).repo.name}`,
    sshUrl: (p) => `git@forge:${store.viewer.login}/${(p as RepoRef).repo.name}.git`,
    isPrivate: (p) => (p as RepoRef).repo.private,
    visibility: (p) => ((p as RepoRef).repo.private ? 'PRIVATE' : 'PUBLIC'),
    isEmpty: (p) => (p as RepoRef).repo.refs.size === 0,
    defaultBranchRef: (p) => {
      const repo = (p as RepoRef).repo;
      const oid = store.branchTip(repo, repo.defaultBranch);
      return oid ? { t: 'Ref', v: { repo, name: `refs/heads/${repo.defaultBranch}`, oid } } : null;
    },
    viewerPermission: () => 'ADMIN',
    viewerCanAdminister: () => true,
    viewerDefaultMergeMethod: () => 'MERGE',
    viewerDefaultCommitEmail: () => store.viewer.email,
    viewerPossibleCommitEmails: () => [store.viewer.email],
    hasIssuesEnabled: (p) => (p as RepoRef).repo.hasIssues,
    mergeCommitAllowed: () => true,
    squashMergeAllowed: () => true,
    rebaseMergeAllowed: () => true,
    forkingAllowed: () => true,
    createdAt: (p) => (p as RepoRef).repo.createdAt,
    updatedAt: (p) => (p as RepoRef).repo.updatedAt,
    pushedAt: (p) => (p as RepoRef).repo.pushedAt,
    issue: (p, a) => {
      const repo = (p as RepoRef).repo;
      const issue = repo.issueByNumber.get(Number(a.number));
      if (!issue || issue.pull) throw new GqlError(`Could not resolve to an Issue with the number of ${String(a.number)}.`);
      return issueObj(repo, issue);
    },
    issueOrPullRequest: (p, a) => {
      const repo = (p as RepoRef).repo;
      const issue = repo.issueByNumber.get(Number(a.number));
      if (!issue) throw new GqlError(`Could not resolve to an issue or pull request with the number of ${String(a.number)}.`);
      return issueObj(repo, issue);
    },
    issues: (p, a) => {
      const repo = (p as RepoRef).repo;
      const filter = (a.filterBy ?? {}) as Record<string, unknown>;
      const states = (Array.isArray(a.states) ? a.states : Array.isArray(filter.states) ? filter.states : null) as string[] | null;
      const labels = (Array.isArray(a.labels) ? a.labels : Array.isArray(filter.labels) ? filter.labels : null) as string[] | null;
      let list = repo.issues.filter((i) => !i.pull);
      if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
      if (labels) list = list.filter((i) => labels.some((l) => i.labels.some((x) => x.toLowerCase() === l.toLowerCase())));
      return connection('IssueConnection', sortIssues(list, a.orderBy).map((i) => issueObj(repo, i)), a);
    },
    pullRequest: (p, a) => {
      const repo = (p as RepoRef).repo;
      const issue = repo.issueByNumber.get(Number(a.number));
      if (!issue || !issue.pull) throw new GqlError(`Could not resolve to a PullRequest with the number of ${String(a.number)}.`);
      return issueObj(repo, issue);
    },
    pullRequests: (p, a) => {
      const repo = (p as RepoRef).repo;
      const states = Array.isArray(a.states) ? (a.states as string[]) : null;
      let list = repo.issues.filter((i) => i.pull);
      if (states) list = list.filter((i) => states.includes(prState(i)));
      if (typeof a.headRefName === 'string') list = list.filter((i) => i.pull!.head === a.headRefName);
      if (typeof a.baseRefName === 'string') list = list.filter((i) => i.pull!.base === a.baseRefName);
      return connection('PullRequestConnection', sortIssues(list, a.orderBy).map((i) => issueObj(repo, i)), a);
    },
    labels: (p, a) => {
      const repo = (p as RepoRef).repo;
      let labels = [...repo.labels.values()];
      if (typeof a.query === 'string') labels = labels.filter((l) => l.name.toLowerCase().includes((a.query as string).toLowerCase()));
      return connection('LabelConnection', labels.map((label) => ({ t: 'Label', v: { repo, label } })), a);
    },
    label: (p, a) => {
      const repo = (p as RepoRef).repo;
      const label = repo.labels.get(String(a.name).toLowerCase());
      return label ? { t: 'Label', v: { repo, label } } : null;
    },
    ref: (p, a) => {
      const repo = (p as RepoRef).repo;
      const q = String(a.qualifiedName);
      const name = q.startsWith('refs/') ? q : `refs/heads/${q}`;
      const oid = repo.refs.get(name);
      return oid ? { t: 'Ref', v: { repo, name, oid } } : null;
    },
    refs: (p, a) => {
      const repo = (p as RepoRef).repo;
      const prefix = String(a.refPrefix ?? 'refs/heads/');
      const refs = [...repo.refs.entries()].filter(([r]) => r.startsWith(prefix)).sort().map(([name, oid]) => ({ t: 'Ref', v: { repo, name, oid } }));
      return connection('RefConnection', refs, a);
    },
    object: (p, a) => {
      const repo = (p as RepoRef).repo;
      const oid = typeof a.oid === 'string' ? a.oid : undefined;
      return oid && repo.db.commit(oid) ? { t: 'Commit', v: { repo, oid } } : null;
    },
    assignableUsers: (_p, a) => connection('UserConnection', [userObj()], a),
    mentionableUsers: (_p, a) => connection('UserConnection', [userObj()], a),
    watchers: (_p, a) => connection('UserConnection', [], a),
  },
  Issue: {
    id: (p) => nodeId('I', (p as IssueRef).issue.id),
    databaseId: (p) => (p as IssueRef).issue.id,
    fullDatabaseId: (p) => String((p as IssueRef).issue.id),
    number: (p) => (p as IssueRef).issue.number,
    title: (p) => (p as IssueRef).issue.title,
    titleHTML: (p) => (p as IssueRef).issue.title,
    body: (p) => (p as IssueRef).issue.body ?? '',
    bodyText: (p) => (p as IssueRef).issue.body ?? '',
    bodyHTML: (p) => (p as IssueRef).issue.body ?? '',
    state: (p) => (p as IssueRef).issue.state.toUpperCase(),
    stateReason: (p) => ((p as IssueRef).issue.stateReason ? ((p as IssueRef).issue.stateReason as string).toUpperCase() : null),
    closed: (p) => (p as IssueRef).issue.state === 'closed',
    closedAt: (p) => (p as IssueRef).issue.closedAt,
    createdAt: (p) => (p as IssueRef).issue.createdAt,
    updatedAt: (p) => (p as IssueRef).issue.updatedAt,
    url: (p) => webUrl(`${store.viewer.login}/${(p as IssueRef).repo.name}/issues/${(p as IssueRef).issue.number}`),
    resourcePath: (p) => `/${store.viewer.login}/${(p as IssueRef).repo.name}/issues/${(p as IssueRef).issue.number}`,
    author: () => userObj(),
    locked: () => false,
    repository: (p) => ({ t: 'Repository', v: { repo: (p as IssueRef).repo } }),
    authorAssociation: () => 'OWNER',
    viewerCanUpdate: () => true,
    viewerCanClose: () => true,
    viewerCanReopen: () => true,
    labels: (p, a) => {
      const { repo, issue } = p as IssueRef;
      return connection('LabelConnection', issue.labels.map((n) => repo.labels.get(n.toLowerCase())).filter((l): l is Label => !!l).map((label) => ({ t: 'Label', v: { repo, label } })), a);
    },
    comments: (p, a) => {
      const { repo, issue } = p as IssueRef;
      return connection('IssueCommentConnection', issue.comments.map((c) => ({ t: 'IssueComment', v: { repo, issue, c } })), a);
    },
    assignees: (p, a) => connection('UserConnection', (p as IssueRef).issue.assignees.length ? [userObj()] : [], a),
    projectCards: (_p, a) => connection('ProjectCardConnection', [], a),
    projectItems: (_p, a) => connection('ProjectV2ItemConnection', [], a),
    trackedIssues: (_p, a) => connection('IssueConnection', [], a),
    trackedInIssues: (_p, a) => connection('IssueConnection', [], a),
    subIssues: (_p, a) => connection('IssueConnection', [], a),
    closedByPullRequestsReferences: (_p, a) => connection('PullRequestConnection', [], a),
    reactionGroups: () => [],
  },
  PullRequest: {},
  IssueComment: {
    id: (p) => nodeId('IC', (p as CommentRef).c.id),
    databaseId: (p) => (p as CommentRef).c.id,
    body: (p) => (p as CommentRef).c.body,
    bodyText: (p) => (p as CommentRef).c.body,
    bodyHTML: (p) => (p as CommentRef).c.body,
    author: () => userObj(),
    createdAt: (p) => (p as CommentRef).c.createdAt,
    updatedAt: (p) => (p as CommentRef).c.updatedAt,
    url: (p) => webUrl(`${store.viewer.login}/${(p as CommentRef).repo.name}/issues/${(p as CommentRef).issue.number}#issuecomment-${(p as CommentRef).c.id}`),
    issue: (p) => ({ t: 'Issue', v: { repo: (p as CommentRef).repo, issue: (p as CommentRef).issue } }),
    pullRequest: (p) => ((p as CommentRef).issue.pull ? { t: 'PullRequest', v: { repo: (p as CommentRef).repo, issue: (p as CommentRef).issue } } : null),
    authorAssociation: () => 'OWNER',
    viewerDidAuthor: () => true,
    isMinimized: () => false,
    reactionGroups: () => [],
  },
  Label: {
    id: (p) => nodeId('LA', (p as LabelRef).label.id),
    name: (p) => (p as LabelRef).label.name,
    color: (p) => (p as LabelRef).label.color,
    description: (p) => (p as LabelRef).label.description,
    isDefault: () => false,
    url: (p) => webUrl(`${store.viewer.login}/${(p as LabelRef).repo.name}/labels/${encodeURIComponent((p as LabelRef).label.name)}`),
  },
  Ref: {
    id: (p) => nodeId('REF', (p as RefRef).repo.id),
    name: (p) => (p as RefRef).name.replace(/^refs\/(heads|tags)\//, ''),
    prefix: (p) => (/^refs\/(heads|tags)\//.exec((p as RefRef).name)?.[0] ?? 'refs/'),
    target: (p) => ({ t: 'Commit', v: { repo: (p as RefRef).repo, oid: (p as RefRef).repo.db.peel((p as RefRef).oid) } }),
    repository: (p) => ({ t: 'Repository', v: { repo: (p as RefRef).repo } }),
  },
  Commit: {
    id: (p) => `C_${(p as CommitRef).oid}`,
    oid: (p) => (p as CommitRef).oid,
    abbreviatedOid: (p) => (p as CommitRef).oid.slice(0, 7),
    message: (p) => ((p as CommitRef).repo.db.commit((p as CommitRef).oid)?.message ?? '').replace(/\n$/, ''),
    messageHeadline: (p) => ((p as CommitRef).repo.db.commit((p as CommitRef).oid)?.message ?? '').split('\n')[0],
    messageBody: (p) => ((p as CommitRef).repo.db.commit((p as CommitRef).oid)?.message ?? '').split('\n').slice(2).join('\n').trim(),
    committedDate: (p) => commitDate((p as CommitRef).repo, (p as CommitRef).oid),
    authoredDate: (p) => commitDate((p as CommitRef).repo, (p as CommitRef).oid),
    url: (p) => webUrl(`${store.viewer.login}/${(p as CommitRef).repo.name}/commit/${(p as CommitRef).oid}`),
    author: (p) => ({ t: 'GitActor', v: { name: store.viewer.name, email: store.viewer.email, date: commitDate((p as CommitRef).repo, (p as CommitRef).oid) } }),
    committer: (p) => ({ t: 'GitActor', v: { name: store.viewer.name, email: store.viewer.email, date: commitDate((p as CommitRef).repo, (p as CommitRef).oid) } }),
  },
  RateLimit: { limit: () => 5000, cost: () => 1, remaining: () => 4999, used: () => 1, resetAt: () => '2030-01-01T00:00:00Z', nodeCount: () => 0 },
};

function commitDate(repo: Repo, oid: string): string | null {
  const c = repo.db.commit(oid);
  if (!c) return null;
  const m = / (\d+) [+-]\d{4}$/.exec(c.committer);
  return m ? new Date(Number(m[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

// PullRequest reuses the Issue resolvers for the shared fields.
Object.assign(R.PullRequest as Record<string, Resolver>, R.Issue, {
  id: (p: unknown) => nodeId('PR', (p as IssueRef).issue.id),
  state: (p: unknown) => prState((p as IssueRef).issue),
  url: (p: unknown) => webUrl(`${store.viewer.login}/${(p as IssueRef).repo.name}/pull/${(p as IssueRef).issue.number}`),
  permalink: (p: unknown) => webUrl(`${store.viewer.login}/${(p as IssueRef).repo.name}/pull/${(p as IssueRef).issue.number}`),
  resourcePath: (p: unknown) => `/${store.viewer.login}/${(p as IssueRef).repo.name}/pull/${(p as IssueRef).issue.number}`,
  headRefName: (p: unknown) => (p as IssueRef).issue.pull!.head,
  baseRefName: (p: unknown) => (p as IssueRef).issue.pull!.base,
  headRefOid: (p: unknown) => pullTips((p as IssueRef).repo, (p as IssueRef).issue).headSha,
  baseRefOid: (p: unknown) => pullTips((p as IssueRef).repo, (p as IssueRef).issue).baseSha,
  headRef: (p: unknown) => {
    const { repo, issue } = p as IssueRef;
    const oid = store.branchTip(repo, issue.pull!.head);
    return oid ? { t: 'Ref', v: { repo, name: `refs/heads/${issue.pull!.head}`, oid } } : null;
  },
  baseRef: (p: unknown) => {
    const { repo, issue } = p as IssueRef;
    const oid = store.branchTip(repo, issue.pull!.base);
    return oid ? { t: 'Ref', v: { repo, name: `refs/heads/${issue.pull!.base}`, oid } } : null;
  },
  headRepository: (p: unknown) => ({ t: 'Repository', v: { repo: (p as IssueRef).repo } }),
  baseRepository: (p: unknown) => ({ t: 'Repository', v: { repo: (p as IssueRef).repo } }),
  headRepositoryOwner: () => userObj(),
  isCrossRepository: () => false,
  isDraft: (p: unknown) => (p as IssueRef).issue.pull!.draft,
  mergeable: (p: unknown) => {
    const { repo, issue } = p as IssueRef;
    if (issue.state !== 'open') return 'UNKNOWN';
    return isMergeable(repo, issue) ? 'MERGEABLE' : 'CONFLICTING';
  },
  mergeStateStatus: (p: unknown) => {
    const { repo, issue } = p as IssueRef;
    if (issue.state !== 'open') return 'UNKNOWN';
    return isMergeable(repo, issue) ? 'CLEAN' : 'DIRTY';
  },
  merged: (p: unknown) => (p as IssueRef).issue.pull!.merged,
  mergedAt: (p: unknown) => (p as IssueRef).issue.pull!.mergedAt,
  mergedBy: (p: unknown) => ((p as IssueRef).issue.pull!.merged ? userObj() : null),
  mergeCommit: (p: unknown) => {
    const { repo, issue } = p as IssueRef;
    return issue.pull!.mergeCommitSha ? { t: 'Commit', v: { repo, oid: issue.pull!.mergeCommitSha } } : null;
  },
  potentialMergeCommit: () => null,
  additions: (p: unknown) => pullFiles((p as IssueRef).repo, (p as IssueRef).issue).reduce((s, f) => s + f.additions, 0),
  deletions: (p: unknown) => pullFiles((p as IssueRef).repo, (p as IssueRef).issue).reduce((s, f) => s + f.deletions, 0),
  changedFiles: (p: unknown) => pullFiles((p as IssueRef).repo, (p as IssueRef).issue).length,
  files: (p: unknown, a: Record<string, unknown>) => {
    const { repo, issue } = p as IssueRef;
    const files = pullFiles(repo, issue).map((f) => ({ t: 'PullRequestChangedFile', v: { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED', viewerViewedState: 'UNVIEWED' } }));
    return connection('PullRequestChangedFileConnection', files, a);
  },
  commits: (p: unknown, a: Record<string, unknown>) => {
    const { repo, issue } = p as IssueRef;
    return connection('PullRequestCommitConnection', pullCommits(repo, issue).map((oid) => ({ t: 'PullRequestCommit', v: { id: `PRC_${oid}`, commit: { t: 'Commit', v: { repo, oid } }, url: '' } })), a);
  },
  reviewRequests: (_p: unknown, a: Record<string, unknown>) => connection('ReviewRequestConnection', [], a),
  reviews: (_p: unknown, a: Record<string, unknown>) => connection('PullRequestReviewConnection', [], a),
  latestReviews: (_p: unknown, a: Record<string, unknown>) => connection('PullRequestReviewConnection', [], a),
  reviewDecision: () => null,
  maintainerCanModify: () => false,
  autoMergeRequest: () => null,
  statusCheckRollup: () => null,
  viewerCanMergeAsAdmin: () => true,
  viewerCanEnableAutoMerge: () => false,
  viewerCanDisableAutoMerge: () => false,
  isInMergeQueue: () => false,
  isMergeQueueEnabled: () => false,
  closingIssuesReferences: (_p: unknown, a: Record<string, unknown>) => connection('IssueConnection', [], a),
  revertUrl: () => '',
  totalCommentsCount: (p: unknown) => (p as IssueRef).issue.comments.length,
});

function needIssueNode(id: unknown): IssueRef {
  const node = nodeById(id);
  if (!node || node.t !== 'Issue') throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`);
  return node.v as IssueRef;
}

function needPullNode(id: unknown): IssueRef {
  const node = nodeById(id);
  if (!node || node.t !== 'PullRequest') throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`);
  return node.v as IssueRef;
}

function searchIssueItems(q: string): Obj[] {
  let repoFilter: Repo | undefined;
  let state: string | null = null;
  let type: string | null = null;
  const words: string[] = [];
  for (const term of q.split(/\s+/).filter(Boolean)) {
    const m = /^(\w+):(.+)$/.exec(term);
    if (!m) {
      words.push(term.toLowerCase());
      continue;
    }
    const k = m[1];
    const v = m[2] as string;
    if (k === 'repo') {
      const [o, r] = v.split('/');
      repoFilter = store.getRepo(o ?? '', r ?? '');
      if (!repoFilter) return [];
    } else if ((k === 'is' || k === 'state') && (v === 'open' || v === 'closed')) state = v;
    else if ((k === 'is' || k === 'type') && (v === 'issue' || v === 'pr')) type = v;
  }
  const out: Obj[] = [];
  for (const repo of repoFilter ? [repoFilter] : [...store.repos.values()]) {
    for (const issue of repo.issues) {
      if (state && issue.state !== state) continue;
      if (type === 'issue' && issue.pull) continue;
      if (type === 'pr' && !issue.pull) continue;
      const text = `${issue.title} ${issue.body ?? ''}`.toLowerCase();
      if (words.every((w) => text.includes(w))) out.push(issueObj(repo, issue));
    }
  }
  return out.reverse();
}

// ================================================================== introspection

function typeRef(t: string): Record<string, unknown> {
  if (t.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) };
  if (t.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) };
  return { kind: T[t]?.kind ?? 'SCALAR', name: t, ofType: null };
}

function introspectType(name: string): Obj | null {
  return T[name] ? { t: '__Type', v: { name } } : null;
}

function introspectField(sel: FieldNode, parent: Obj, args: Record<string, unknown>): unknown {
  const v = parent.v as Record<string, unknown>;
  if (parent.t === '__Type') {
    const name = v.name as string | null;
    if (name === null) {
      const ref = v.ref as Record<string, unknown>;
      if (sel.name === 'kind') return ref.kind;
      if (sel.name === 'name') return null;
      if (sel.name === 'ofType') return ref.ofType ? { t: '__Type', v: refToType(ref.ofType as Record<string, unknown>) } : null;
      return null;
    }
    const def = T[name] as TypeDef;
    switch (sel.name) {
      case 'name': return name;
      case 'kind': return def.kind;
      case 'description': return def.desc ?? null;
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      case 'fields':
        if (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE') return null;
        return Object.entries(def.fields ?? {}).map(([fname, f]) => ({ t: '__Field', v: { name: fname, f } }));
      case 'enumValues':
        if (def.kind !== 'ENUM') return null;
        return (def.values ?? []).map((ev) => ({ t: '__EnumValue', v: { name: ev } }));
      case 'inputFields':
        if (def.kind !== 'INPUT_OBJECT') return null;
        return Object.entries(def.inputs ?? {}).map(([iname, it]) => ({ t: '__InputValue', v: { name: iname, type: it } }));
      case 'interfaces':
        return def.kind === 'OBJECT' ? (def.interfaces ?? []).map((i) => ({ t: '__Type', v: { name: i } })) : null;
      case 'possibleTypes':
        return def.kind === 'INTERFACE' || def.kind === 'UNION' ? (def.possible ?? []).map((i) => ({ t: '__Type', v: { name: i } })) : null;
      default: return null;
    }
  }
  if (parent.t === '__Field') {
    const f = v.f as FieldDef;
    switch (sel.name) {
      case 'name': return v.name;
      case 'description': return f.desc ?? null;
      case 'args': return Object.entries(f.args ?? {}).map(([an, at]) => ({ t: '__InputValue', v: { name: an, type: at } }));
      case 'type': return { t: '__Type', v: refToType(typeRef(f.type)) };
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return null;
    }
  }
  if (parent.t === '__InputValue') {
    switch (sel.name) {
      case 'name': return v.name;
      case 'description': return null;
      case 'type': return { t: '__Type', v: refToType(typeRef(v.type as string)) };
      case 'defaultValue': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return null;
    }
  }
  if (parent.t === '__EnumValue') {
    switch (sel.name) {
      case 'name': return v.name;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return null;
    }
  }
  if (parent.t === '__Schema') {
    switch (sel.name) {
      case 'queryType': return { t: '__Type', v: { name: 'Query' } };
      case 'mutationType': return { t: '__Type', v: { name: 'Mutation' } };
      case 'subscriptionType': return null;
      case 'types': return Object.keys(T).map((n) => ({ t: '__Type', v: { name: n } }));
      case 'directives': return [];
      case 'description': return null;
      default: return null;
    }
  }
  void args;
  return null;
}

function refToType(ref: Record<string, unknown>): Record<string, unknown> {
  if (ref.kind === 'NON_NULL' || ref.kind === 'LIST') return { name: null, ref };
  return { name: ref.name };
}

const INTROSPECTION_TYPES: Record<string, string[]> = {
  __Type: ['kind', 'name', 'description', 'fields', 'interfaces', 'possibleTypes', 'enumValues', 'inputFields', 'ofType', 'specifiedByURL', 'isOneOf'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};
const INTROSPECTION_RETURNS: Record<string, string> = {
  fields: '__Field', interfaces: '__Type', possibleTypes: '__Type', enumValues: '__EnumValue', inputFields: '__InputValue', ofType: '__Type',
  args: '__InputValue', type: '__Type', types: '__Type', queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', directives: '__Directive',
};

// ================================================================== validation + execution

interface ExecCtx {
  vars: Record<string, unknown>;
  frags: Map<string, Fragment>;
  errors: Array<Record<string, unknown>>;
}

function validate(sel: Selection[], typeName: string, frags: Map<string, Fragment>, errors: string[], depth = 0): void {
  if (depth > 40) return;
  for (const s of sel) {
    if (s.kind === 'spread') {
      const f = frags.get(s.name);
      if (!f) {
        errors.push(`Fragment ${s.name} was used, but not defined`);
        continue;
      }
      validate(f.sel, f.on, frags, errors, depth + 1);
      continue;
    }
    if (s.kind === 'inline') {
      if (s.on !== null && !T[s.on]) {
        errors.push(`No such type ${s.on}, so it can't be a fragment condition`);
        continue;
      }
      validate(s.sel, s.on ?? typeName, frags, errors, depth + 1);
      continue;
    }
    if (s.name === '__typename') continue;
    if (typeName.startsWith('__')) {
      const known = INTROSPECTION_TYPES[typeName] ?? [];
      if (!known.includes(s.name)) {
        errors.push(`Field '${s.name}' doesn't exist on type '${typeName}'`);
        continue;
      }
      if (s.sel) validate(s.sel, INTROSPECTION_RETURNS[s.name] ?? '__Type', frags, errors, depth + 1);
      continue;
    }
    if (typeName === 'Query' && (s.name === '__type' || s.name === '__schema')) {
      if (s.sel) validate(s.sel, s.name === '__type' ? '__Type' : '__Schema', frags, errors, depth + 1);
      continue;
    }
    const def = T[typeName];
    const field = def?.fields?.[s.name];
    if (!field) {
      errors.push(`Field '${s.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    const rt = baseType(field.type);
    const kind = T[rt]?.kind ?? 'SCALAR';
    const composite = kind === 'OBJECT' || kind === 'INTERFACE' || kind === 'UNION';
    if (composite && !s.sel) errors.push(`Field must have selections (field '${s.name}' returns ${rt} but has no selections. Did you mean '${s.name} { ... }'?)`);
    else if (!composite && s.sel) errors.push(`Selections can't be made on scalars (field '${s.name}' returns ${rt} but has selections [${s.sel.map((x) => (x.kind === 'field' ? x.name : '...')).join(', ')}])`);
    else if (s.sel) validate(s.sel, rt, frags, errors, depth + 1);
    for (const [an] of s.args) if (!field.args || !(an in field.args)) errors.push(`Field '${s.name}' doesn't accept argument '${an}'`);
  }
}

function evalValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.k) {
    case 'var': return vars[v.name] ?? null;
    case 'int': case 'float': return v.v;
    case 'str': return v.v;
    case 'bool': return v.v;
    case 'null': return null;
    case 'enum': return v.v;
    case 'list': return v.v.map((x) => evalValue(x, vars));
    case 'obj': return Object.fromEntries(v.v.map(([k, x]) => [k, evalValue(x, vars)]));
    default: return null;
  }
}

/** Flatten a selection set for a concrete type: fragments applied, fields merged by response key. */
function collect(sel: Selection[], typeName: string, frags: Map<string, Fragment>, out: Map<string, FieldNode[]> = new Map()): Map<string, FieldNode[]> {
  for (const s of sel) {
    if (s.kind === 'field') {
      const list = out.get(s.alias) ?? [];
      list.push(s);
      out.set(s.alias, list);
    } else if (s.kind === 'inline') {
      if (s.on === null || implementsType(typeName, s.on)) collect(s.sel, typeName, frags, out);
    } else {
      const f = frags.get(s.name);
      if (f && implementsType(typeName, f.on)) collect(f.sel, typeName, frags, out);
    }
  }
  return out;
}

function execSelection(sel: Selection[], obj: Obj, ctx: ExecCtx, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, fields] of collect(sel, obj.t, ctx.frags)) {
    const field = fields[0] as FieldNode;
    const subSel = fields.flatMap((f) => f.sel ?? []);
    out[key] = execField(field, subSel, obj, ctx, [...path, key]);
  }
  return out;
}

function execField(field: FieldNode, subSel: Selection[], parent: Obj, ctx: ExecCtx, path: Array<string | number>): unknown {
  if (field.name === '__typename') return parent.t;
  const args: Record<string, unknown> = {};
  for (const [k, v] of field.args) args[k] = evalValue(v, ctx.vars);
  let value: unknown;
  try {
    if (parent.t.startsWith('__')) {
      value = introspectField(field, parent, args);
    } else if (parent.t === 'Query' && field.name === '__type') {
      value = introspectType(String(args.name));
    } else if (parent.t === 'Query' && field.name === '__schema') {
      value = { t: '__Schema', v: {} };
    } else {
      const resolver = R[parent.t]?.[field.name];
      if (resolver) value = resolver(parent.v, args);
      else value = defaultResolve(parent, field.name, args);
    }
  } catch (err) {
    const message = err instanceof ApiError ? apiMessage(err) : err instanceof Error ? err.message : String(err);
    const entry: Record<string, unknown> = { message, path, locations: [{ line: field.loc[0], column: field.loc[1] }] };
    if (err instanceof ApiError) entry.type = err.status === 404 ? 'NOT_FOUND' : err.status === 422 ? 'UNPROCESSABLE' : 'FORBIDDEN';
    else entry.type = 'NOT_FOUND';
    ctx.errors.push(entry);
    return null;
  }
  return complete(value, subSel, ctx, path);
}

function apiMessage(err: ApiError): string {
  const first = Array.isArray(err.errors) ? (err.errors[0] as Record<string, unknown> | undefined) : undefined;
  if (first && typeof first.message === 'string') return first.message;
  return err.message;
}

function complete(value: unknown, subSel: Selection[], ctx: ExecCtx, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v, i) => complete(v, subSel, ctx, [...path, i]));
  if (typeof value === 'object' && 't' in (value as Obj) && 'v' in (value as Obj)) {
    if (subSel.length === 0) return null;
    return execSelection(subSel, value as Obj, ctx, path);
  }
  return value;
}

/** Plain-data objects (payloads, connections, edges) resolve by property. */
function defaultResolve(parent: Obj, name: string, args: Record<string, unknown>): unknown {
  const v = parent.v as Record<string, unknown>;
  if (parent.t.endsWith('Connection')) {
    const nodeT = nodeTypeOf(parent.t);
    const list = (v.list ?? []) as Array<{ node: unknown; cursor: string }>;
    if (name === 'nodes') return list.map((e) => toObj(e.node, nodeT));
    if (name === 'edges') return list.map((e) => ({ t: parent.t.replace(/Connection$/, 'Edge'), v: { node: toObj(e.node, nodeT), cursor: e.cursor } }));
    if (name === 'pageInfo') return { t: 'PageInfo', v: v.pageInfo };
    if (name === 'totalCount') return v.total;
    if (name in v) return v[name];
    return 0;
  }
  void args;
  if (v && typeof v === 'object' && name in v) {
    const out = v[name];
    if (out && typeof out === 'object' && !Array.isArray(out) && !('t' in (out as Obj))) {
      const ft = T[parent.t]?.fields?.[name];
      if (ft) return { t: baseType(ft.type), v: out };
    }
    return out;
  }
  const ft = T[parent.t]?.fields?.[name];
  if (ft) {
    const rt = baseType(ft.type);
    if (rt.endsWith('Connection')) return connection(rt, [], args);
    if (ft.type.endsWith('!')) {
      if (rt === 'Boolean') return false;
      if (rt === 'Int' || rt === 'Float') return 0;
      if (rt === 'String' || rt === 'URI' || rt === 'HTML') return '';
    }
  }
  return null;
}

function toObj(node: unknown, t: string): unknown {
  if (node && typeof node === 'object' && 't' in (node as Obj)) return node;
  return wrap(t, node);
}

function runOne(op: unknown): { body: Record<string, unknown>; ok: boolean } {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return { body: { errors: [{ message: 'A query attribute must be specified and must be a string.' }] }, ok: false };
  const o = op as Record<string, unknown>;
  if (typeof o.query !== 'string' || o.query.trim() === '') return { body: { errors: [{ message: 'A query attribute must be specified and must be a string.' }] }, ok: false };
  let doc: { ops: Operation[]; frags: Map<string, Fragment> };
  try {
    doc = new Parser(o.query).document();
  } catch (err) {
    const e = err as GqlError;
    return { body: { errors: [{ message: e.message, locations: e.locations ?? [] }] }, ok: true };
  }
  let opDef: Operation | undefined;
  if (typeof o.operationName === 'string' && o.operationName !== '') opDef = doc.ops.find((x) => x.name === o.operationName);
  else if (doc.ops.length === 1) opDef = doc.ops[0];
  if (!opDef) {
    const message = doc.ops.length === 0 ? 'No operations in query document' : typeof o.operationName === 'string' ? `Unknown operation named "${o.operationName}"` : 'An operation name is required';
    return { body: { errors: [{ message }] }, ok: true };
  }
  const root = opDef.type === 'mutation' ? 'Mutation' : 'Query';
  const verrors: string[] = [];
  validate(opDef.sel, root, doc.frags, verrors);
  const rawVars = (o.variables && typeof o.variables === 'object' && !Array.isArray(o.variables) ? o.variables : {}) as Record<string, unknown>;
  const vars: Record<string, unknown> = {};
  for (const v of opDef.vars) {
    if (v.name in rawVars) vars[v.name] = rawVars[v.name];
    else if (v.def) vars[v.name] = evalValue(v.def, {});
    else if (v.type.endsWith('!')) verrors.push(`Variable $${v.name} of type ${v.type} was provided invalid value`);
  }
  if (verrors.length) return { body: { errors: verrors.map((message) => ({ message })) }, ok: true };
  const ctx: ExecCtx = { vars, frags: doc.frags, errors: [] };
  const data = execSelection(opDef.sel, { t: root, v: {} }, ctx, []);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return { body, ok: true };
}

export function handleGraphql(body: unknown, base: string): { status: number; body: unknown } {
  BASE.url = base;
  if (Array.isArray(body)) return { status: 200, body: body.map((op) => runOne(op).body) };
  const r = runOne(body);
  return { status: r.ok ? 200 : 400, body: r.body };
}
