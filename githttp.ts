// git smart HTTP: info/refs, git-upload-pack (protocol v2, with a v0 fallback) and
// git-receive-pack (v0 with report-status, side-band-64k and delete-refs).

import type { ServerResponse } from 'node:http';
import { ZERO_OID, buildPack, collectForFetch, isComplete, isOid, parseTag, readPack, type GitObj } from './git.ts';
import { store, type Repo } from './store.ts';

const AGENT = 'agent=forge/1.0';

// ------------------------------------------------------------------ pkt-line

export function pkt(line: string | Buffer): Buffer {
  const body = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
  const len = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'latin1'), body]);
}

const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode pkt-lines from the start of `buf`; stops at the first flush when `untilFlush`. Returns packets and the offset reached. */
function decodePkts(buf: Buffer, untilFlush: boolean): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('latin1', i, i + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
      if (untilFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, offset: i };
}

function lineOf(p: Packet): string | null {
  return p.kind === 'data' ? p.payload.toString('utf8').replace(/\n$/, '') : null;
}

/** Wrap data into side-band-64k band-1 packets (max 65515 payload bytes each). */
function sideband(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = 65515;
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, Math.min(data.length, i + max));
    const len = (chunk.length + 5).toString(16).padStart(4, '0');
    out.push(Buffer.from(len, 'latin1'), Buffer.from([band]), chunk);
  }
  return out;
}

function send(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${JSON.stringify({ message })}\n`);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// ------------------------------------------------------------------ refs

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ------------------------------------------------------------------ info/refs

function uploadPackCapsV0(repo: Repo): string {
  const caps = ['multi_ack_detailed', 'side-band-64k', 'side-band', 'thin-pack', 'ofs-delta', 'shallow', 'deepen-since', 'deepen-not', 'deepen-relative', 'no-progress', 'include-tag', 'allow-tip-sha1-in-want', 'allow-reachable-sha1-in-want', 'no-done', 'object-format=sha1', AGENT];
  if (repo.refs.has(headTarget(repo))) caps.unshift(`symref=HEAD:${headTarget(repo)}`);
  return caps.join(' ');
}

const RECEIVE_CAPS = `report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 ${AGENT}`;

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : RECEIVE_CAPS;
  const lines: string[] = [];
  if (service === 'git-upload-pack') {
    const head = repo.refs.get(headTarget(repo));
    if (head) lines.push(`${head} HEAD`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${name}`);
    if (service === 'git-upload-pack' && name.startsWith('refs/tags/')) {
      const peeled = repo.db.peel(oid);
      if (peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, i) => parts.push(pkt(i === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

const V2_ADVERT = Buffer.concat([
  pkt('version 2\n'),
  pkt(`${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('server-option\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

export function handleInfoRefs(res: ServerResponse, repo: Repo, service: string, gitProtocol: string): void {
  if (service === 'git-upload-pack') {
    if (/version=2/.test(gitProtocol)) {
      send(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERT);
      return;
    }
    send(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
    return;
  }
  if (service === 'git-receive-pack') {
    send(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    return;
  }
  sendJson(res, 403, 'Unsupported service');
}

// ------------------------------------------------------------------ upload-pack

export function handleUploadPack(res: ServerResponse, repo: Repo, body: Buffer, gitProtocol: string): void {
  let decoded: { packets: Packet[]; offset: number };
  try {
    decoded = decodePkts(body, false);
  } catch {
    sendJson(res, 400, 'malformed pkt-line request');
    return;
  }
  const first = decoded.packets[0] ? lineOf(decoded.packets[0]) : null;
  if (/version=2/.test(gitProtocol) || (first !== null && first.startsWith('command='))) {
    v2Command(res, repo, decoded.packets);
    return;
  }
  v0UploadPack(res, repo, decoded.packets);
}

const fetchCache = new WeakMap<Repo, Map<string, Buffer> & { version: number }>();

function v2Command(res: ServerResponse, repo: Repo, packets: Packet[]): void {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (p.kind === 'flush') break;
    const line = lineOf(p);
    if (line === null) continue;
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') {
    send(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, args));
    return;
  }
  if (command === 'fetch') {
    // Identical fetches against an unchanged repository (a burst of clones) share one answer.
    const key = `${repo.version}
${args.filter((a) => !a.startsWith('agent=')).join('
')}`;
    let out = fetchCache.get(repo)?.get(key);
    if (!out) {
      out = v2Fetch(repo, args);
      let perRepo = fetchCache.get(repo);
      if (!perRepo || perRepo.version !== repo.version) {
        perRepo = Object.assign(new Map<string, Buffer>(), { version: repo.version });
        fetchCache.set(repo, perRepo);
      }
      if (perRepo.size < 64 && out.length < 32 * 1024 * 1024) perRepo.set(key, out);
    }
    send(res, 200, 'application/x-git-upload-pack-result', out);
    return;
  }
  sendJson(res, 400, `unknown command ${command}`);
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const head = repo.refs.get(target);
  if (keep('HEAD')) {
    if (head) parts.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = repo.db.peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Fetch(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow = new Set<string>();
  let depth: number | null = null;
  let done = false;
  let noProgress = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('want-ref ')) {
      const oid = repo.refs.get(a.slice(9).trim());
      if (oid) wants.push(oid);
    } else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.add(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = Math.max(1, parseInt(a.slice(7), 10) || 1);
    else if (a === 'done') done = true;
    else if (a === 'no-progress') noProgress = true;
  }
  void noProgress;
  const parts: Buffer[] = [];
  const common = haves.filter((h) => repo.db.has(h));
  if (!done) {
    parts.push(pkt('acknowledgments\n'));
    if (common.length === 0) parts.push(pkt('NAK\n'));
    for (const c of common) parts.push(pkt(`ACK ${c}\n`));
    parts.push(pkt('ready\n'));
    parts.push(DELIM);
  }
  const valid = wants.filter((w) => isOid(w) && repo.db.has(w));
  const result = collectForFetch(repo.db, valid, common, shallow, depth);
  if (depth !== null || shallow.size > 0) {
    const lines = [...result.shallow.map((s) => `shallow ${s}\n`), ...result.unshallow.map((u) => `unshallow ${u}\n`)];
    if (lines.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const l of lines) parts.push(pkt(l));
      parts.push(DELIM);
    }
  }
  parts.push(pkt('packfile\n'));
  const pack = buildPack(result.objects.map((oid) => repo.db.get(oid) as GitObj));
  parts.push(...sideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v0UploadPack(res: ServerResponse, repo: Repo, packets: Packet[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow = new Set<string>();
  let depth: number | null = null;
  let caps = '';
  for (const p of packets) {
    const line = lineOf(p);
    if (line === null) continue;
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const sp = rest.indexOf(' ');
      if (sp >= 0) {
        if (caps === '') caps = rest.slice(sp + 1);
        wants.push(rest.slice(0, sp));
      } else wants.push(rest.trim());
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Math.max(1, parseInt(line.slice(7), 10) || 1);
  }
  if (wants.length === 0 || !wants.every((w) => isOid(w))) {
    sendJson(res, 400, 'malformed upload-pack request');
    return;
  }
  const parts: Buffer[] = [];
  const common = haves.filter((h) => repo.db.has(h));
  const valid = wants.filter((w) => repo.db.has(w));
  const result = collectForFetch(repo.db, valid, common, shallow, depth);
  if (depth !== null) {
    for (const s of result.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const u of result.unshallow) parts.push(pkt(`unshallow ${u}\n`));
    parts.push(FLUSH);
  }
  if (common.length > 0) parts.push(pkt(`ACK ${common[common.length - 1]}\n`));
  else parts.push(pkt('NAK\n'));
  const pack = buildPack(result.objects.map((oid) => repo.db.get(oid) as GitObj));
  if (/side-band-64k/.test(caps)) {
    parts.push(...sideband(1, pack));
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ------------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  let decoded: { packets: Packet[]; offset: number };
  try {
    decoded = decodePkts(body, true);
  } catch {
    sendJson(res, 400, 'malformed pkt-line request');
    return;
  }
  const commands: RefCommand[] = [];
  let caps = '';
  for (const p of decoded.packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1).trim();
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (!m) {
      sendJson(res, 400, 'malformed receive-pack command');
      return;
    }
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  if (commands.length === 0) {
    send(res, 200, 'application/x-git-receive-pack-result', FLUSH);
    return;
  }
  const useSideband = /\bside-band-64k\b/.test(caps);
  const packData = body.subarray(decoded.offset);
  let unpack = 'ok';
  const added: string[] = [];
  try {
    if (packData.length > 0) {
      const objs = readPack(packData, (oid) => repo.db.get(oid));
      for (const o of objs) {
        if (!repo.db.has(o.oid)) {
          repo.db.putKnown(o.oid, o.type, o.data);
          added.push(o.oid);
          repo.version += 1;
        }
      }
    }
  } catch (err) {
    unpack = (err instanceof Error ? err.message : String(err)).replace(/\n/g, ' ');
  }
  const lines: string[] = [unpack === 'ok' ? 'unpack ok\n' : `unpack ${unpack}\n`];
  for (const cmd of commands) {
    const reason = unpack !== 'ok' ? 'unpacker error' : checkCommand(repo, cmd);
    if (reason === null) {
      store.setRef(repo, cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}\n`);
    } else {
      lines.push(`ng ${cmd.ref} ${reason}\n`);
    }
  }
  const report = Buffer.concat([...lines.map((l) => pkt(l)), FLUSH]);
  const out = useSideband ? Buffer.concat([...sideband(1, report), FLUSH]) : report;
  send(res, 200, 'application/x-git-receive-pack-result', out);
}

function checkCommand(repo: Repo, cmd: RefCommand): string | null {
  if (!cmd.ref.startsWith('refs/') || cmd.ref.includes('..') || /[\s~^:?*[\\]/.test(cmd.ref)) return 'funny refname';
  const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
  if (cmd.newOid === ZERO_OID) {
    if (current === ZERO_OID) return 'remote ref does not exist';
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return 'stale info';
    if (cmd.ref === headTarget(repo) && repo.refs.size > 1) {
      // Deleting the default branch is allowed but keeps HEAD pointing at a missing ref.
    }
    return null;
  }
  if (!repo.db.has(cmd.newOid)) return 'missing necessary objects';
  if (!isComplete(repo.db, cmd.newOid)) return 'missing necessary objects';
  if (current === ZERO_OID) {
    if (cmd.oldOid !== ZERO_OID) return 'stale info';
    return null;
  }
  if (cmd.oldOid !== current) {
    // The client's view is stale; refuse like a fast-forward check would.
    if (!repo.db.isAncestor(current, cmd.newOid)) return 'non-fast-forward';
    return 'stale info';
  }
  if (cmd.ref.startsWith('refs/tags/')) return 'already exists';
  const newCommit = repo.db.peel(cmd.newOid);
  const curCommit = repo.db.peel(current);
  if (!repo.db.isAncestor(curCommit, newCommit)) return 'non-fast-forward';
  return null;
}

export function tagTarget(repo: Repo, oid: string): string {
  const o = repo.db.get(oid);
  return o && o.type === 'tag' ? parseTag(o.data).object : oid;
}
