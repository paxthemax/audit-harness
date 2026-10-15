import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { HarnessError } from '../core/errors.ts';
import type { AgentClient } from '../review/session.ts';

// A minimal Model Context Protocol server: newline-delimited JSON-RPC 2.0 over arbitrary streams
// (stdio in production, in-memory streams in tests). It serves tools only. Nothing but protocol
// messages is ever written to `output`; diagnostics go to `log`.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpToolResult {
  text: string;
  structured?: unknown;
  isError?: boolean;
}

export interface McpToolContext {
  /** The client named in `initialize` (`clientInfo`), or null when it gave none. */
  client: AgentClient | null;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema of the `arguments` object. */
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: McpTool[];
  input: Readable;
  output: Writable;
  log?: (line: string) => void;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number;

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Serve MCP over `input`/`output` until `input` ends. Tool calls run one at a time in arrival order
 * (harness operations must not interleave); `ping` and `tools/list` are answered immediately. The
 * promise resolves once input has ended and every accepted call has been answered.
 */
export async function serveMcp(opts: McpServerOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  let initialized = false;
  let client: AgentClient | null = null;
  let queue: Promise<void> = Promise.resolve();

  const send = (msg: Record<string, unknown>): void => {
    opts.output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  };
  const replyError = (id: Id | null, code: number, message: string): void => send({ id, error: { code, message } });

  const initialize = (params: Record<string, unknown>): Record<string, unknown> => {
    if (initialized) throw new RpcError(INVALID_REQUEST, 'already initialized');
    const requested = params.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.find((v) => v === requested) ?? PROTOCOL_VERSIONS[0];
    const info = params.clientInfo;
    if (isObject(info)) {
      client = {
        name: typeof info.name === 'string' && info.name ? info.name : 'unknown',
        version: typeof info.version === 'string' && info.version ? info.version : 'unknown',
      };
    }
    initialized = true;
    log(`mcp: initialized (protocol ${protocolVersion}, client ${client ? `${client.name}/${client.version}` : 'unknown'})`);
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: opts.name, version: opts.version },
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    };
  };

  const callTool = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name');
    const tool = tools.get(params.name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'tool arguments must be an object');
    let r: McpToolResult;
    try {
      r = await tool.handler(args, { client });
    } catch (e) {
      r = errorResult(e);
      log(`mcp: ${tool.name} failed: ${r.text.split('\n')[0]}`);
    }
    const structured = r.structured === undefined ? undefined : isObject(r.structured) ? r.structured : { result: r.structured };
    return {
      content: [{ type: 'text', text: r.text }],
      ...(structured === undefined ? {} : { structuredContent: structured }),
      ...(r.isError ? { isError: true } : {}),
    };
  };

  const dispatch = (method: string, params: Record<string, unknown>): Promise<unknown> | unknown => {
    if (method === 'initialize') return initialize(params);
    if (method === 'ping') return {};
    if (!initialized) throw new RpcError(INVALID_REQUEST, 'server not initialized: send initialize first');
    if (method === 'tools/list') return { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    if (method === 'tools/call') {
      // Serialise tool calls; a failure inside one never breaks the chain.
      const run = queue.then(() => callTool(params));
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    }
    throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
  };

  const pending = new Set<Promise<void>>();
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, PARSE_ERROR, 'parse error: each line must be one JSON-RPC message');
      return;
    }
    if (!isObject(msg)) {
      replyError(null, INVALID_REQUEST, 'invalid request: expected one JSON-RPC object per line (batches are not supported)');
      return;
    }
    const hasId = 'id' in msg;
    const id = msg.id;
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    if (typeof msg.method !== 'string') {
      // A response to a request we never sent (we send none): ignore it.
      if (hasId && ('result' in msg || 'error' in msg)) return;
      replyError(validId ? (id as Id) : null, INVALID_REQUEST, 'invalid request: missing method');
      return;
    }
    if (msg.jsonrpc !== '2.0' || (hasId && !validId) || (msg.params !== undefined && !isObject(msg.params))) {
      if (hasId) replyError(validId ? (id as Id) : null, INVALID_REQUEST, 'invalid request: needs jsonrpc "2.0", a string or number id, and object params');
      return;
    }
    const method = msg.method;
    const params = (msg.params as Record<string, unknown> | undefined) ?? {};
    if (!hasId) {
      // Notifications (initialized, cancelled, ...) never get a response.
      if (method === 'notifications/initialized') log('mcp: client ready');
      return;
    }
    const p = (async () => {
      try {
        send({ id, result: await dispatch(method, params) });
      } catch (e) {
        if (e instanceof RpcError) replyError(id as Id, e.code, e.message);
        else {
          log(`mcp: internal error in ${method}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
          replyError(id as Id, INTERNAL_ERROR, 'internal error');
        }
      }
    })();
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  for await (const line of rl) handleLine(line);
  while (pending.size) await Promise.all([...pending]);
}

/** A tool result for a thrown error: the harness code, reason and next action the agent can act on. */
export function errorResult(e: unknown): McpToolResult {
  if (e instanceof HarnessError) {
    const j = e.toJSON();
    const lines = [`${j.code}: ${j.reason}`, `Next: ${j.next}`];
    if (j.details !== undefined) lines.push(`Details: ${JSON.stringify(j.details)}`);
    if (j.committed) lines.push('Note: the operation was committed before the error.');
    return { text: lines.join('\n'), structured: { error: j }, isError: true };
  }
  const reason = e instanceof Error ? e.message : String(e);
  return { text: `error: ${reason}`, structured: { error: { code: 'internal', reason } }, isError: true };
}
