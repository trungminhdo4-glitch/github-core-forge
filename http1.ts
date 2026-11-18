// A small HTTP/1.1 server on node:net: the forge's one wire layer. It parses each request on a
// keep-alive connection itself (request line, headers, a content-length or chunked body), hands the
// handler a whole request with its body already read, and writes each answer, head and body, in one
// corked write. node:http does the same job with more objects, events and timers per request; the
// suite's timed workloads are thousands of small sequential requests, so that overhead is most of
// the server's own time.
//
// Requests on one connection are answered one at a time, in order (pipelined requests wait in the
// buffer). Every answer carries content-length; nothing streams.

import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { STATUS_CODES } from 'node:http';

export type HeaderValue = string | number;

/** The request a handler sees: method, request target, lower-cased headers. */
export interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** The response a handler writes: writeHead and/or setHeader, then exactly one end(). */
export interface Res {
  statusCode: number;
  readonly headersSent: boolean;
  setHeader(name: string, value: HeaderValue): void;
  writeHead(status: number, headers?: Readonly<Record<string, HeaderValue>>): void;
  end(body?: string | Buffer): void;
}

export type Handler = (req: Req, res: Res, body: Buffer) => void | Promise<void>;

/** The listening server, with node:http's closeAllConnections for the lifecycle's exit. */
export type ForgeServer = Server & { closeAllConnections(): void };

const MAX_HEAD_BYTES = 64 * 1024;
const CRLF2 = Buffer.from('\r\n\r\n', 'latin1');
const EMPTY = Buffer.alloc(0);
const CONTINUE = 'HTTP/1.1 100 Continue\r\n\r\n';

const STATUS_LINES: string[] = [];
function statusLine(status: number): string {
  let line = STATUS_LINES[status];
  if (line === undefined) {
    line = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Unknown'}\r\n`;
    if (status >= 100 && status < 600) STATUS_LINES[status] = line;
  }
  return line;
}

class Response implements Res {
  statusCode = 200;
  headersSent = false;
  private headers: Record<string, HeaderValue> = Object.create(null);
  private done = false;
  private readonly conn: Connection;
  private readonly head: boolean;
  private readonly close: boolean;

  constructor(conn: Connection, head: boolean, close: boolean) {
    this.conn = conn;
    this.head = head;
    this.close = close;
  }

  setHeader(name: string, value: HeaderValue): void {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(status: number, headers?: Readonly<Record<string, HeaderValue>>): void {
    this.statusCode = status;
    if (headers !== undefined) for (const name in headers) this.headers[name.toLowerCase()] = headers[name] as HeaderValue;
  }

  end(body?: string | Buffer): void {
    if (this.done) return;
    this.done = true;
    this.headersSent = true;
    const status = this.statusCode;
    const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
    let payload: Buffer | string = body ?? EMPTY;
    const headers = this.headers;
    if (noBody) {
      payload = EMPTY;
      delete headers['content-length'];
    } else {
      const length = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
      headers['content-length'] = length;
    }
    let text = statusLine(status);
    for (const name in headers) text += `${name}: ${headers[name]}\r\n`;
    if (this.close) text += 'connection: close\r\n';
    text += '\r\n';
    const socket = this.conn.socket;
    if (!socket.destroyed) {
      if (this.head || payload.length === 0) socket.write(text, 'latin1');
      else if (typeof payload === 'string') socket.write(text + payload, 'utf8');
      else {
        socket.cork();
        socket.write(text, 'latin1');
        socket.write(payload);
        socket.uncork();
      }
    }
    this.conn.finished(this.close);
  }
}

/** One keep-alive connection: its unparsed bytes and whether a request is being answered. */
class Connection {
  private buf: Buffer = EMPTY;
  private busy = false;
  private closing = false;
  private continued = false;
  readonly socket: Socket;
  private readonly handler: Handler;

  constructor(socket: Socket, handler: Handler) {
    this.socket = socket;
    this.handler = handler;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.pump();
    });
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      if (!this.busy) socket.end();
      else this.closing = true;
    });
  }

  /** Called by the response once it is written: answer the next buffered request, if any. */
  finished(close: boolean): void {
    this.busy = false;
    if (close || this.closing) {
      this.closing = true;
      this.socket.end();
      return;
    }
    if (this.buf.length > 0) this.pump();
  }

  private fail(status: number): void {
    this.closing = true;
    this.buf = EMPTY;
    if (!this.socket.destroyed) this.socket.end(`${statusLine(status)}content-length: 0\r\nconnection: close\r\n\r\n`, 'latin1');
  }

  /** Parse and dispatch one whole request from the buffer, when one is there and none is in flight. */
  private pump(): void {
    if (this.busy || this.closing) return;
    const buf = this.buf;
    // Tolerate stray CRLFs between requests (RFC 9112 2.2).
    let start = 0;
    while (start + 1 < buf.length && buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const headEnd = buf.indexOf(CRLF2, start);
    if (headEnd < 0) {
      if (buf.length - start > MAX_HEAD_BYTES) this.fail(431);
      return;
    }
    const lines = buf.toString('latin1', start, headEnd).split('\r\n');
    const requestLine = lines[0] as string;
    const sp1 = requestLine.indexOf(' ');
    const sp2 = requestLine.lastIndexOf(' ');
    if (sp1 <= 0 || sp2 <= sp1) return this.fail(400);
    const method = requestLine.slice(0, sp1);
    const url = requestLine.slice(sp1 + 1, sp2);
    const version = requestLine.slice(sp2 + 1);
    if (!version.startsWith('HTTP/1.')) return this.fail(505);
    const headers: Record<string, string> = Object.create(null);
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const colon = line.indexOf(':');
      if (colon <= 0) return this.fail(400);
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const prior = headers[name];
      headers[name] = prior === undefined ? value : `${prior}, ${value}`;
    }

    let bodyStart = headEnd + 4;
    let body: Buffer;
    let next: number;
    const te = headers['transfer-encoding'];
    if (te !== undefined && /\bchunked\b/i.test(te)) {
      const decoded = decodeChunked(buf, bodyStart);
      if (decoded === 'bad') return this.fail(400);
      if (decoded === null) return this.expectContinue(headers);
      body = decoded.body;
      next = decoded.end;
    } else {
      const cl = headers['content-length'];
      let length = 0;
      if (cl !== undefined) {
        if (!/^\d+$/.test(cl)) return this.fail(400);
        length = Number(cl);
      }
      if (buf.length - bodyStart < length) return this.expectContinue(headers);
      body = length === 0 ? EMPTY : buf.subarray(bodyStart, bodyStart + length);
      next = bodyStart + length;
    }
    this.buf = next >= buf.length ? EMPTY : buf.subarray(next);
    this.continued = false;

    const connection = (headers.connection ?? '').toLowerCase();
    const close = version === 'HTTP/1.0' ? !/\bkeep-alive\b/.test(connection) : /\bclose\b/.test(connection);
    this.busy = true;
    const res = new Response(this, method === 'HEAD', close);
    const req: Req = { method, url, headers };
    try {
      const done = this.handler(req, res, body);
      if (done instanceof Promise) done.catch((err) => this.crash(res, err));
    } catch (err) {
      this.crash(res, err);
    }
  }

  /** A body is still on its way: answer 100 Continue once when the client asked for it. */
  private expectContinue(headers: Record<string, string>): void {
    if (!this.continued && (headers.expect ?? '').toLowerCase() === '100-continue') {
      this.continued = true;
      this.socket.write(CONTINUE, 'latin1');
    }
  }

  private crash(res: Response, err: unknown): void {
    if (res.headersSent) return;
    const text = `${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n`;
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  }
}

/** Decode a chunked body starting at `from`: the body and where it ends, null while incomplete, 'bad' when malformed. */
function decodeChunked(buf: Buffer, from: number): { body: Buffer; end: number } | null | 'bad' {
  const parts: Buffer[] = [];
  let i = from;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', i, 'latin1');
    if (lineEnd < 0) return buf.length - i > 1024 ? 'bad' : null;
    const sizeText = buf.toString('latin1', i, lineEnd).split(';')[0]!.trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return 'bad';
    const size = parseInt(sizeText, 16);
    i = lineEnd + 2;
    if (size === 0) {
      // Trailers end with an empty line.
      for (;;) {
        const end = buf.indexOf('\r\n', i, 'latin1');
        if (end < 0) return null;
        if (end === i) return { body: parts.length === 1 ? parts[0]! : Buffer.concat(parts), end: end + 2 };
        i = end + 2;
      }
    }
    if (buf.length < i + size + 2) return null;
    parts.push(buf.subarray(i, i + size));
    i += size + 2;
  }
}

/** A server that answers every request with `handler`; it binds nothing until the caller listens. */
export function createForgeServer(handler: Handler): ForgeServer {
  const sockets = new Set<Socket>();
  const server = createNetServer({ noDelay: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    new Connection(socket, handler);
  }) as ForgeServer;
  server.closeAllConnections = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  return server;
}
