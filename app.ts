// The forge's HTTP server: one node:http server for git smart HTTP, REST v3, GraphQL v4 and MCP.
// Every reply but git's carries JSON; every reply carries a non-empty X-GitHub-Request-Id.

import { createForgeServer, type ForgeServer, type Req as IncomingMessage, type Res as ServerResponse } from './http1.ts';
import { gunzipSync, inflateSync } from 'node:zlib';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `F0RG:${requestSeq.toString(16).toUpperCase().padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The request body, decompressed when it says content-encoding gzip or deflate. */
function decodeBody(req: IncomingMessage, raw: Buffer): Buffer {
  const enc = req.headers['content-encoding'];
  if (enc === undefined || raw.length === 0) return raw;
  const lower = enc.toLowerCase();
  try {
    if (lower === 'gzip' || lower === 'x-gzip') return gunzipSync(raw);
    if (lower === 'deflate') return inflateSync(raw);
  } catch {
    // leave it; the handler reports the malformed body
  }
  return raw;
}

type Auth = 'ok' | 'missing' | 'bad';

function authOf(req: IncomingMessage): Auth {
  const header = req.headers.authorization;
  if (header === undefined || header.trim() === '') return 'missing';
  const m = /^\s*(bearer|token)\s+(\S+)\s*$/i.exec(header);
  let token: string | null = m ? (m[2] as string) : null;
  if (token === null) {
    const b = /^\s*basic\s+(\S+)\s*$/i.exec(header);
    if (b) {
      const decoded = Buffer.from(b[1] as string, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      token = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      if (TOKEN !== '' && token !== TOKEN && decoded.slice(0, colon) === TOKEN) token = TOKEN;
    }
  }
  if (token === null || token === '') return 'missing';
  if (TOKEN === '' || token === TOKEN) return 'ok';
  return 'bad';
}

function unauthorized(res: ServerResponse, auth: Auth, rid: string, git = false): void {
  const headers: Record<string, string> = { 'x-github-request-id': rid };
  if (git) headers['www-authenticate'] = 'Basic realm="forge"';
  sendJson(res, 401, { message: auth === 'missing' ? 'Requires authentication' : 'Bad credentials', documentation_url: 'https://docs.github.com/rest' }, headers);
}

/**
 * Bumped by every request that may change the store (anything but GET and HEAD, on every surface).
 * A cached GET answer is good only while the epoch it was made in still holds.
 */
let epoch = 0;

/** GET /api/v3/repos/{owner}/{repo}/issues/{number}: the one read the suite repeats thousands of times. */
const ISSUE_GET_RE = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/issues\/\d+$/;

interface CachedReply {
  epoch: number;
  status: number;
  text: string;
  headers: Record<string, string>;
}
/** Every issue of a trial fits: the cache is keyed by request target, not by position. */
const issueCache = new Map<string, CachedReply>();

/** Request targets new URL() would leave as they are: plain path characters, no dot segment, no fragment. */
const PLAIN_TARGET_RE = /^\/(?!\/)[A-Za-z0-9\-._~/:@!$&'()*+,;=]*(?:\?[^#\s]*)?$/;
const DOT_SEGMENT_RE = /(?:^|\/)\.\.?(?:\/|\?|$)/;

/** The request target's path and query, without new URL() for the common plain form. */
function parseTarget(target: string): { pathname: string; searchParams: URLSearchParams } {
  if (PLAIN_TARGET_RE.test(target) && !DOT_SEGMENT_RE.test(target)) {
    const q = target.indexOf('?');
    if (q < 0) return { pathname: target, searchParams: new URLSearchParams() };
    return { pathname: target.slice(0, q), searchParams: new URLSearchParams(target.slice(q + 1)) };
  }
  return new URL(target, 'http://forge');
}

const GIT_RE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handle(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  const rid = requestId();
  res.setHeader('x-github-request-id', rid);
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    epoch += 1;
    if (issueCache.size > 0) issueCache.clear();
  }
  let url: { pathname: string; searchParams: URLSearchParams };
  try {
    url = parseTarget(req.url ?? '/');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const base = `http://${req.headers.host ?? 'localhost'}`;

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP
  const g = GIT_RE.exec(path);
  if (g) {
    const auth = authOf(req);
    if (auth !== 'ok') {
      unauthorized(res, auth, rid, true);
      return;
    }
    const owner = decodeURIComponent(g[1] as string);
    const name = decodeURIComponent(g[2] as string);
    const action = g[3] as string;
    const repo = store.getRepo(owner, name);
    const body = method === 'POST' ? decodeBody(req, rawBody) : Buffer.alloc(0);
    if (!repo) {
      sendJson(res, 404, { message: 'Repository not found' });
      return;
    }
    const proto = (req.headers['git-protocol'] ?? '').toString();
    try {
      if (action === 'info/refs' && method === 'GET') handleInfoRefs(res, repo, url.searchParams.get('service') ?? '', proto);
      else if (action === 'git-upload-pack' && method === 'POST') handleUploadPack(res, repo, body, proto);
      else if (action === 'git-receive-pack' && method === 'POST') handleReceivePack(res, repo, body);
      else sendJson(res, 405, { message: 'Method Not Allowed' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
    return;
  }

  // ---- JSON surfaces
  const isApi = path === '/api/v3' || path.startsWith('/api/v3/');
  const isGraphql = path === '/api/graphql' || path === '/graphql' || path === '/api/v3/graphql';
  const isMcp = path === '/mcp' || path === '/mcp/';
  if (!isApi && !isGraphql && !isMcp) {
    sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
    return;
  }
  const raw = decodeBody(req, rawBody);

  if (isMcp) {
    await handleMcp(req, res, raw, authOf(req));
    return;
  }

  const auth = authOf(req);
  if (auth !== 'ok') {
    unauthorized(res, auth, rid);
    return;
  }

  let body: unknown;
  const text = raw.toString('utf8');
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
  }

  if (isGraphql) {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const reply = handleGraphql(body, base);
    sendJson(res, reply.status, reply.body);
    return;
  }

  const cacheable = method === 'GET' && body === undefined && store.loginKnown && ISSUE_GET_RE.test(path);
  if (cacheable) {
    const key = `${req.url}\n${base}`;
    const hit = issueCache.get(key);
    if (hit !== undefined && hit.epoch === epoch) {
      res.writeHead(hit.status, hit.headers);
      res.end(hit.text);
      return;
    }
    const segs = path.slice('/api/v3'.length).split('/').filter((p) => p !== '');
    const reply = handleRest({ method, segs, query: url.searchParams, body, base });
    if (reply.status !== 200 || reply.body === undefined) {
      sendJson(res, reply.status, reply.body, reply.headers ?? {});
      return;
    }
    // The same bytes sendJson writes, kept for the next identical read in this epoch.
    const text = `${JSON.stringify(reply.body)}\n`;
    const headers = { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)), ...(reply.headers ?? {}) };
    if (issueCache.size >= 512) issueCache.clear();
    issueCache.set(key, { epoch, status: 200, text, headers });
    res.writeHead(200, headers);
    res.end(text);
    return;
  }

  const segs = path.slice('/api/v3'.length).split('/').filter((p) => p !== '');
  const reply = handleRest({ method, segs, query: url.searchParams, body, base });
  sendJson(res, reply.status, reply.body, reply.headers ?? {});
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): ForgeServer {
  return createForgeServer((req: IncomingMessage, res: ServerResponse, body: Buffer) =>
    handle(req, res, body).catch((err) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        else res.end();
      } catch {
        // the socket is gone
      }
    }),
  );
}
