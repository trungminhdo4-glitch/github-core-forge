// Git object model, packfiles and the in-memory object database.
//
// Everything here is plain Node: SHA-1 from node:crypto, zlib from node:zlib. Objects are kept
// decompressed in memory; each object's packed form (pack entry header + deflated body) is cached
// the first time it is sent so repeated clones cost a buffer copy, not a deflate.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
  /** Cached pack entry (header + zlib body), filled lazily. */
  packed?: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

// ------------------------------------------------------------------ object parsing

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree');
    const mode = data.toString('latin1', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const x = Buffer.from(treeSortKey(a));
    const y = Buffer.from(treeSortKey(b));
    return Buffer.compare(x, y);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const c: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
  }
  return c;
}

export interface Tag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const t: Tag = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) t.object = line.slice(7);
    else if (line.startsWith('type ')) t.type = line.slice(5);
    else if (line.startsWith('tag ')) t.tag = line.slice(4);
    else if (line.startsWith('tagger ')) t.tagger = line.slice(7);
  }
  return t;
}

/** "Name <email> 1700000000 +0000" → its parts. */
export function parseIdent(ident: string): { name: string; email: string; time: number; tz: string } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (!m) return { name: ident, email: '', time: 0, tz: '+0000' };
  return { name: m[1] as string, email: m[2] as string, time: Number(m[3]), tz: m[4] as string };
}

export function serializeCommit(c: Commit): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

// ------------------------------------------------------------------ object database

/** One store per repository (repositories never share objects, so deleting one frees it). */
export class ObjectDB {
  objects = new Map<string, GitObj>();
  /** Objects whose whole closure is known to be present (so a push's check can stop at them). */
  connected = new Set<string>();
  /** Parsed commit cache. */
  private commits = new Map<string, Commit>();
  /** Parsed tree cache. Tree oids are content-addressed, so a parsed tree never goes stale. */
  private trees = new Map<string, TreeEntry[]>();
  /** Tree-build cache: reuse the oid when a directory's entries are unchanged. */
  private treeBuilds = new Map<string, string>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  commit(oid: string): Commit | undefined {
    let c = this.commits.get(oid);
    if (c) return c;
    const o = this.objects.get(oid);
    if (!o || o.type !== 'commit') return undefined;
    c = parseCommit(o.data);
    this.commits.set(oid, c);
    return c;
  }

  tree(oid: string): TreeEntry[] | undefined {
    const cached = this.trees.get(oid);
    if (cached !== undefined) return cached;
    const o = this.objects.get(oid);
    if (!o || o.type !== 'tree') return undefined;
    const entries = parseTree(o.data);
    this.trees.set(oid, entries);
    return entries;
  }

  /** Peel tags until a non-tag object. */
  peel(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 20; i += 1) {
      const o = this.objects.get(cur);
      if (!o || o.type !== 'tag') return cur;
      cur = parseTag(o.data).object;
    }
    return cur;
  }

  /** Is `ancestor` reachable from `descendant` (inclusive)? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = this.commit(cur);
      if (c) for (const p of c.parents) stack.push(p);
    }
    return false;
  }

  /** The first common ancestor found by a BFS from both sides (good enough for linear-ish history). */
  mergeBase(a: string, b: string): string | null {
    const fromA = new Set<string>();
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift() as string;
      if (fromA.has(cur)) continue;
      fromA.add(cur);
      const c = this.commit(cur);
      if (c) for (const p of c.parents) queue.push(p);
    }
    const seen = new Set<string>();
    const q2 = [b];
    while (q2.length) {
      const cur = q2.shift() as string;
      if (fromA.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = this.commit(cur);
      if (c) for (const p of c.parents) q2.push(p);
    }
    return null;
  }

  /** Flatten a tree into path → {oid, mode}. */
  flatten(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const entries = this.tree(treeOid);
    if (!entries) return out;
    for (const e of entries) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flatten(e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** Build trees from a flat path map and return the root tree oid. */
  writeFlat(files: Map<string, { oid: string; mode: string }>): string {
    interface Dir { files: TreeEntry[]; dirs: Map<string, Dir> }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, f] of files) {
      const parts = path.split('/');
      let d = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i] as string;
        let next = d.dirs.get(name);
        if (!next) {
          next = { files: [], dirs: new Map() };
          d.dirs.set(name, next);
        }
        d = next;
      }
      d.files.push({ mode: f.mode, name: parts[parts.length - 1] as string, oid: f.oid });
    }
    const write = (d: Dir): string => {
      const entries = [...d.files];
      for (const [name, sub] of d.dirs) entries.push({ mode: '40000', name, oid: write(sub) });
      const key = entries.map((e) => `${e.mode}\0${e.name}\0${e.oid}`).sort().join('\x01');
      const hit = this.treeBuilds.get(key);
      if (hit !== undefined) return hit;
      const oid = this.put('tree', serializeTree(entries));
      this.treeBuilds.set(key, oid);
      return oid;
    };
    return write(root);
  }

  /** Look up a path inside a tree: a blob/tree entry or undefined. */
  lookupPath(treeOid: string, path: string): TreeEntry | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    if (parts.length === 0) return { mode: '40000', name: '', oid: treeOid };
    let cur = treeOid;
    let found: TreeEntry | undefined;
    for (const part of parts) {
      const entries = this.tree(cur);
      if (!entries) return undefined;
      found = entries.find((e) => e.name === part);
      if (!found) return undefined;
      cur = found.oid;
    }
    return found;
  }
}

// ------------------------------------------------------------------ pack reading

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[i++] as number;
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const baseSize = readVar();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVar();
  const out = Buffer.allocUnsafe(resultSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++] as number;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off |= delta[i++] as number;
      if (op & 0x02) off |= (delta[i++] as number) << 8;
      if (op & 0x04) off |= (delta[i++] as number) << 16;
      if (op & 0x08) off = (off | ((delta[i++] as number) << 24)) >>> 0;
      if (op & 0x10) size |= delta[i++] as number;
      if (op & 0x20) size |= (delta[i++] as number) << 8;
      if (op & 0x40) size |= (delta[i++] as number) << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, o, off, off + size);
      o += size;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op);
      o += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (o !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface UnpackedObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/**
 * Read a version 2/3 pack. `external` resolves ref-delta bases the pack does not hold (thin packs).
 * Returns the objects in pack order; throws on any corruption.
 */
export function readPack(pack: Buffer, external: (oid: string) => GitObj | undefined): UnpackedObject[] {
  if (pack.length < 32) {
    if (pack.length === 0) return [];
    throw new Error('pack too short');
  }
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack checksum mismatch');
  interface Entry { offset: number; typeNum: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: UnpackedObject }
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let byte = pack[pos++] as number;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Entry = { offset: start, typeNum, data: Buffer.alloc(0) };
    if (typeNum === 6) {
      byte = pack[pos++] as number;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++] as number;
        off = ((off + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = start - off;
    } else if (typeNum === 7) {
      entry.baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    } else if (!NUM_TYPE[typeNum]) {
      throw new Error(`bad pack object type ${typeNum}`);
    }
    const res = inflateSync(pack.subarray(pos, pack.length - 20), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = res.buffer;
    if (entry.data.length !== size) throw new Error('pack object size mismatch');
    pos += res.engine.bytesWritten;
    entries.push(entry);
    byOffset.set(start, entry);
  }
  if (pos !== pack.length - 20) throw new Error('pack has trailing bytes');
  const byOid = new Map<string, UnpackedObject>();
  const resolve = (e: Entry, depth: number): UnpackedObject => {
    if (e.resolved) return e.resolved;
    if (depth > 5000) throw new Error('delta chain too deep');
    let result: UnpackedObject;
    if (e.typeNum <= 4) {
      const type = NUM_TYPE[e.typeNum] as ObjType;
      result = { oid: hashObject(type, e.data), type, data: e.data };
    } else {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (e.baseOffset !== undefined) {
        const b = byOffset.get(e.baseOffset);
        if (!b) throw new Error('ofs-delta base missing');
        base = resolve(b, depth + 1);
      } else {
        const oid = e.baseOid as string;
        base = byOid.get(oid);
        if (!base) {
          const be = entries.find((x) => x.resolved?.oid === oid || (x.typeNum <= 4 && !x.resolved && hashObject(NUM_TYPE[x.typeNum] as ObjType, x.data) === oid));
          if (be) base = resolve(be, depth + 1);
        }
        if (!base) base = external(oid);
        if (!base) throw new Error(`ref-delta base ${oid} missing`);
      }
      const data = applyDelta(base.data, e.data);
      result = { oid: hashObject(base.type, data), type: base.type, data };
    }
    e.resolved = result;
    byOid.set(result.oid, result);
    return result;
  };
  // Non-delta objects first so ref-delta lookups by oid hit the map.
  for (const e of entries) if (e.typeNum <= 4) resolve(e, 0);
  for (const e of entries) resolve(e, 0);
  return entries.map((e) => e.resolved as UnpackedObject);
}

// ------------------------------------------------------------------ pack writing

function entryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeNum << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

export function packedEntry(o: GitObj): Buffer {
  if (!o.packed) o.packed = Buffer.concat([entryHeader(TYPE_NUM[o.type], o.data.length), deflateSync(o.data, { level: 1 })]);
  return o.packed;
}

/** A whole pack of undeltified objects, as a list of chunks (header, entries, trailer). */
export function buildPack(objs: GitObj[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objs.length, 8);
  const parts: Buffer[] = [header];
  const h = createHash('sha1');
  h.update(header);
  for (const o of objs) {
    const e = packedEntry(o);
    parts.push(e);
    h.update(e);
  }
  parts.push(h.digest());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ reachability

/**
 * Objects to send for a fetch. `wants` are tips; `haves` are tips the client holds, whose closure
 * (cut at the client's `shallow` commits) is excluded. `depth` limits the commit walk; the commits
 * at the depth limit that have parents become the new shallow boundary.
 */
export function collectForFetch(
  db: ObjectDB,
  wants: string[],
  haves: string[],
  clientShallow: Set<string>,
  depth: number | null,
): { objects: string[]; shallow: string[]; unshallow: string[] } {
  // 1. What the client holds.
  const held = new Set<string>();
  const holdCommits: string[] = [];
  for (const h of haves) if (db.has(h)) holdCommits.push(h);
  const heldCommits = new Set<string>();
  while (holdCommits.length) {
    const oid = holdCommits.pop() as string;
    if (heldCommits.has(oid)) continue;
    const o = db.get(oid);
    if (!o) continue;
    if (o.type === 'tag') {
      held.add(oid);
      holdCommits.push(parseTag(o.data).object);
      continue;
    }
    if (o.type !== 'commit') {
      markTree(db, oid, held);
      continue;
    }
    heldCommits.add(oid);
    held.add(oid);
    const c = db.commit(oid) as Commit;
    markTree(db, c.tree, held);
    if (!clientShallow.has(oid)) for (const p of c.parents) holdCommits.push(p);
  }

  // 2. Walk from the wants.
  const out: string[] = [];
  const sent = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const commitDepth = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const pushObj = (oid: string): void => {
    if (!sent.has(oid)) {
      sent.add(oid);
      out.push(oid);
    }
  };
  for (const w of wants) {
    let cur = w;
    // Peel tags, sending each tag object.
    for (let i = 0; i < 20; i += 1) {
      const o = db.get(cur);
      if (!o) break;
      if (o.type === 'tag') {
        if (!held.has(cur)) pushObj(cur);
        cur = parseTag(o.data).object;
        continue;
      }
      break;
    }
    const o = db.get(cur);
    if (!o) continue;
    if (o.type === 'commit') queue.push([cur, 1]);
    else if (o.type === 'tree') sendTree(db, cur, held, sent, out);
    else if (!held.has(cur)) pushObj(cur);
  }
  let qi = 0;
  while (qi < queue.length) {
    const [oid, d] = queue[qi++] as [string, number];
    const prev = commitDepth.get(oid);
    if (prev !== undefined && prev <= d) continue;
    commitDepth.set(oid, d);
    const c = db.commit(oid);
    if (!c) continue;
    const atLimit = depth !== null && d >= depth;
    if (depth === null && heldCommits.has(oid)) continue;
    if (!heldCommits.has(oid) && !sent.has(oid)) {
      pushObj(oid);
      sendTree(db, c.tree, held, sent, out);
    }
    if (atLimit) {
      if (c.parents.length > 0 && !clientShallow.has(oid)) shallow.push(oid);
      continue;
    }
    if (depth !== null && clientShallow.has(oid) && c.parents.length > 0) unshallow.push(oid);
    if (depth === null && clientShallow.has(oid)) continue;
    for (const p of c.parents) queue.push([p, d + 1]);
  }
  return { objects: out, shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)] };
}

function markTree(db: ObjectDB, treeOid: string, held: Set<string>): void {
  if (held.has(treeOid)) return;
  held.add(treeOid);
  const entries = db.tree(treeOid);
  if (!entries) return;
  for (const e of entries) {
    if (e.mode === '160000') continue;
    if (e.mode === '40000') markTree(db, e.oid, held);
    else held.add(e.oid);
  }
}

function sendTree(db: ObjectDB, treeOid: string, held: Set<string>, sent: Set<string>, out: string[]): void {
  if (held.has(treeOid) || sent.has(treeOid)) return;
  sent.add(treeOid);
  out.push(treeOid);
  const entries = db.tree(treeOid);
  if (!entries) return;
  for (const e of entries) {
    if (e.mode === '160000') continue;
    if (e.mode === '40000') sendTree(db, e.oid, held, sent, out);
    else if (!held.has(e.oid) && !sent.has(e.oid) && db.has(e.oid)) {
      sent.add(e.oid);
      out.push(e.oid);
    }
  }
}

/** Is every object reachable from `tip` present? (A push must not leave a ref dangling.) */
export function isComplete(db: ObjectDB, tip: string, known: Set<string> = db.connected): boolean {
  const stack = [tip];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || known.has(oid)) continue;
    seen.add(oid);
    const o = db.get(oid);
    if (!o) return false;
    if (o.type === 'commit') {
      const c = db.commit(oid) as Commit;
      stack.push(c.tree, ...c.parents);
    } else if (o.type === 'tree') {
      for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
    } else if (o.type === 'tag') {
      stack.push(parseTag(o.data).object);
    }
  }
  for (const s of seen) known.add(s);
  return true;
}
