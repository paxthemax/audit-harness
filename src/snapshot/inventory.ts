// Deterministic scope inventory and storage layouts derived from compiler artifacts (FR-34;
// design/audit-harness.md, "Initial tool recommendation": the target's pinned compiler/build
// configuration and its artifacts give the scope inventory and storage layouts).
//
// Input is Foundry's `out/` tree (contract in src/runner/hooks.ts): one JSON per contract with `ast`,
// `storageLayout` and `metadata`. Everything here is a pure function of those artifacts plus, when
// supplied, the snapshot's source bytes (for per-symbol content digests). The same artifacts always
// yield the same inventory. Problems the artifacts do not let us resolve are returned, never guessed.

import { digest } from '../core/hash.ts';
import type { Archive } from '../store/archive.ts';

export interface SrcRange {
  start: number;
  length: number;
}

export type SourceOrigin = 'source' | 'test' | 'script' | 'dependency';

export interface LowLevelCall {
  kind: 'call' | 'delegatecall' | 'staticcall' | 'callcode' | 'send' | 'transfer';
  /** Target expression as written (e.g. `msg.sender`, `impl`), or `assembly`. */
  target: string;
  in_assembly: boolean;
  src: SrcRange;
}

export interface InternalEdge {
  /** Key of the statically referenced declaration. */
  ref: string;
  name: string;
  signature: string;
  /** The callee is virtual: resolve against the most-derived contract's linearization. */
  virtual: boolean;
}

/** A function, modifier or public-variable getter. */
export interface Callable {
  /** Globally unique and stable across snapshots: `<path>:<Contract>.<signature>`. */
  key: string;
  /** `<Contract>.<signature>`, e.g. `Vault.withdraw(uint256)`. */
  symbol: string;
  contract: string;
  path: string;
  name: string;
  kind: 'function' | 'constructor' | 'fallback' | 'receive' | 'getter' | 'modifier';
  signature: string;
  selector: string | null;
  visibility: string;
  mutability: string | null;
  virtual: boolean;
  overrides: boolean;
  implemented: boolean;
  modifiers: { name: string; ref: string | null; virtual: boolean }[];
  internal_calls: InternalEdge[];
  external_calls: string[];
  unresolved_calls: string[];
  low_level_calls: LowLevelCall[];
  assembly: SrcRange[];
  /**
   * State variables this callable assigns directly (`Contract.var`, declaring contract): assignments,
   * `++`/`--`, `delete`, and `push`/`pop`, including mapping/array element and struct member writes.
   * Writes through local storage pointers and through internal callees are NOT included; follow
   * `internal_calls` to propagate.
   */
  writes: string[];
  /** State variables this callable references (reads and writes alike), directly. */
  reads: string[];
  src: SrcRange;
  /** Digest of the exact source bytes of `src` (null when source bytes were not supplied). */
  content_digest: string | null;
}

export interface StorageVariable {
  name: string;
  type: string;
  visibility: string;
  mutability: string;
  src: SrcRange;
}

export interface InventoryContract {
  name: string;
  path: string;
  origin: SourceOrigin;
  kind: 'contract' | 'interface' | 'library';
  abstract: boolean;
  src: SrcRange;
  content_digest: string | null;
  bases: string[];
  /** Linearized base contracts, most derived first (C3 order from the compiler). */
  linearized: string[];
  functions: Callable[];
  modifiers: Callable[];
  storage_variables: StorageVariable[];
  assembly: { in: string | null; src: SrcRange }[];
  low_level_calls: (LowLevelCall & { in: string | null })[];
  /** External/public entry points including inherited ones (most-derived definition wins). */
  entry_points: { signature: string; selector: string | null; declared_in: string; kind: Callable['kind'] }[];
}

export interface CompilerSettings {
  version: string;
  optimizer: boolean;
  runs: number | null;
  evm_version: string;
  via_ir: boolean;
}

export interface Inventory {
  format: 'harness.inventory/1';
  compiler: CompilerSettings | null;
  sources: { path: string; origin: SourceOrigin }[];
  contracts: InventoryContract[];
  problems: string[];
}

export interface StorageSlotEntry {
  label: string;
  slot: string;
  offset: number;
  type: string;
  /** Contract that declares the variable (differs from the owner for inherited variables). */
  declared_in: string;
}

export interface StorageLayouts {
  format: 'harness.storage_layouts/1';
  /** Keyed by `<path>:<Contract>`. */
  contracts: Record<string, StorageSlotEntry[]>;
}

export interface ArtifactFile {
  /** Path inside the out tree, e.g. `Vault.sol/Vault.json`. */
  path: string;
  json: any;
}

export interface InventoryOptions {
  /** Source bytes by snapshot-relative path, for content digests. */
  sourceBytes?: (path: string) => Uint8Array | null;
  testDirs?: string[];
  scriptDirs?: string[];
  libDirs?: string[];
}

export function classifyOrigin(path: string, o: InventoryOptions = {}): SourceOrigin {
  const under = (dirs: string[]) => dirs.some((d) => path === d || path.startsWith(d.replace(/\/$/, '') + '/'));
  if (/\.t\.sol$/.test(path) || under(o.testDirs ?? ['test'])) return 'test';
  if (/\.s\.sol$/.test(path) || under(o.scriptDirs ?? ['script'])) return 'script';
  if (under(o.libDirs ?? ['lib', 'node_modules'])) return 'dependency';
  return 'source';
}

export function parseSrc(s: string | undefined): SrcRange {
  const [start, length] = (s ?? '0:0').split(':').map(Number);
  return { start: start || 0, length: length || 0 };
}

const LOCATION_SUFFIX = / (?:storage|memory|calldata)(?: (?:pointer|ref|slice))?$/;
function paramType(p: any): string {
  const t: string = p?.typeDescriptions?.typeString ?? p?.typeName?.typeDescriptions?.typeString ?? '?';
  return t.replace(LOCATION_SUFFIX, '').replace(/ (?:storage|memory|calldata)(?: (?:pointer|ref))?/g, '');
}

/** Parameter types of a public variable's getter: mapping keys and array indices, outermost first. */
export function getterParams(type: string): string[] {
  const out: string[] = [];
  let t = type.trim();
  for (;;) {
    const m = /^mapping\((.+?) => (.+)\)$/.exec(t);
    if (m) {
      out.push(m[1].replace(/^contract /, 'address ').split(' ')[0]);
      t = m[2].trim();
      continue;
    }
    if (/\[\d*\]$/.test(t) && !/^(bytes|string)$/.test(t)) {
      out.push('uint256');
      t = t.replace(/\[\d*\]$/, '');
      continue;
    }
    return out;
  }
}

function forEachNode(node: any, fn: (n: any) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) forEachNode(x, fn);
    return;
  }
  if (node.nodeType && fn(node) === false) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') forEachNode(v, fn);
  }
}

function describe(e: any): string {
  if (!e) return '?';
  switch (e.nodeType) {
    case 'Identifier':
      return e.name;
    case 'MemberAccess':
      return `${describe(e.expression)}.${e.memberName}`;
    case 'FunctionCall':
      if (e.kind === 'typeConversion' && e.arguments?.length === 1) return describe(e.arguments[0]);
      return `${describe(e.expression)}()`;
    case 'IndexAccess':
      return `${describe(e.baseExpression)}[…]`;
    case 'ElementaryTypeNameExpression':
      return e.typeName?.name ?? 'type';
    case 'Literal':
      return String(e.value ?? e.hexValue ?? 'literal');
    default:
      return e.nodeType;
  }
}

/** Call targets controlled by the caller (attacker) rather than by hidden target configuration. */
export const CALLER_TARGETS = new Set(['msg.sender', 'tx.origin', '_msgSender()']);

const LOW_LEVEL = new Set(['call', 'delegatecall', 'staticcall', 'callcode', 'send', 'transfer']);
const YUL_CALLS = new Set(['call', 'delegatecall', 'staticcall', 'callcode']);

interface DeclInfo {
  key: string;
  name: string;
  signature: string;
  contractId: number;
  virtual: boolean;
  kind: 'function' | 'modifier' | 'variable';
}

function callableSignature(n: any): { name: string; signature: string; kind: Callable['kind'] } {
  if (n.nodeType === 'ModifierDefinition') {
    const params = (n.parameters?.parameters ?? []).map(paramType).join(',');
    return { name: n.name, signature: `${n.name}(${params})`, kind: 'modifier' };
  }
  if (n.nodeType === 'VariableDeclaration') return { name: n.name, signature: `${n.name}(${getterParams(paramType(n)).join(',')})`, kind: 'getter' };
  const kind: Callable['kind'] = n.kind === 'constructor' ? 'constructor' : n.kind === 'fallback' ? 'fallback' : n.kind === 'receive' ? 'receive' : 'function';
  const name = kind === 'function' ? n.name : kind;
  const params = (n.parameters?.parameters ?? []).map(paramType).join(',');
  return { name, signature: `${name}(${params})`, kind };
}

/**
 * Derive the inventory and storage layouts from Foundry artifacts. Artifacts that carry the same
 * source unit are deduplicated by source path.
 */
export function deriveInventory(artifacts: ArtifactFile[], opts: InventoryOptions = {}): { inventory: Inventory; layouts: StorageLayouts } {
  const problems: string[] = [];
  const units = new Map<string, any>(); // absolutePath -> SourceUnit
  const sorted = [...artifacts].sort((a, b) => a.path.localeCompare(b.path));
  const compilers = new Map<string, CompilerSettings>();
  for (const a of sorted) {
    const ast = a.json?.ast;
    if (!ast || ast.nodeType !== 'SourceUnit' || typeof ast.absolutePath !== 'string') {
      problems.push(`${a.path}: no AST (build without --ast?)`);
      continue;
    }
    const prev = units.get(ast.absolutePath);
    if (!prev) units.set(ast.absolutePath, ast);
    else if (prev.id !== ast.id || prev.src !== ast.src) {
      problems.push(`${ast.absolutePath}: more than one compilation produced this source unit; the first (by artifact path) is used`);
    }
    const meta = typeof a.json.metadata === 'string' ? safeParse(a.json.metadata) : a.json.metadata;
    if (meta?.compiler?.version && meta.settings) {
      const s = meta.settings;
      const c: CompilerSettings = {
        version: String(meta.compiler.version),
        optimizer: !!s.optimizer?.enabled,
        runs: typeof s.optimizer?.runs === 'number' ? s.optimizer.runs : null,
        evm_version: String(s.evmVersion ?? 'unknown'),
        via_ir: !!s.viaIR,
      };
      const target = Object.keys(s.compilationTarget ?? {})[0] ?? ast.absolutePath;
      compilers.set(`${classifyOrigin(target, opts) === 'source' ? 0 : 1}:${JSON.stringify(c)}`, c);
    }
  }

  // Pass 1: declarations by AST id.
  const contractById = new Map<number, { name: string; path: string }>();
  const declById = new Map<number, DeclInfo>();
  for (const [path, unit] of units) {
    for (const c of unit.nodes ?? []) {
      if (c.nodeType !== 'ContractDefinition') continue;
      if (contractById.has(c.id)) problems.push(`AST id ${c.id} is reused across compilation units; call edges may be imprecise`);
      contractById.set(c.id, { name: c.name, path });
      for (const n of c.nodes ?? []) {
        if (n.nodeType === 'FunctionDefinition' || n.nodeType === 'ModifierDefinition') {
          const s = callableSignature(n);
          declById.set(n.id, { key: `${path}:${c.name}.${s.signature}`, name: s.name, signature: s.signature, contractId: c.id, virtual: !!n.virtual, kind: n.nodeType === 'ModifierDefinition' ? 'modifier' : 'function' });
        } else if (n.nodeType === 'VariableDeclaration') {
          declById.set(n.id, { key: `${path}:${c.name}.${n.name}`, name: n.name, signature: `${n.name}()`, contractId: c.id, virtual: false, kind: 'variable' });
        }
      }
    }
    // Free functions.
    for (const n of unit.nodes ?? []) {
      if (n.nodeType === 'FunctionDefinition') {
        const s = callableSignature(n);
        declById.set(n.id, { key: `${path}:<free>.${s.signature}`, name: s.name, signature: s.signature, contractId: -1, virtual: false, kind: 'function' });
      }
    }
  }

  const sourceBytes = opts.sourceBytes;
  const digestRange = (path: string, r: SrcRange): string | null => {
    const bytes = sourceBytes?.(path);
    if (!bytes) return null;
    if (r.start + r.length > bytes.length) return null;
    return digest(bytes.subarray(r.start, r.start + r.length));
  };

  // Pass 2: callables with their call edges.
  const contracts: InventoryContract[] = [];
  const sources: Inventory['sources'] = [];
  for (const [path, unit] of [...units].sort((a, b) => a[0].localeCompare(b[0]))) {
    const origin = classifyOrigin(path, opts);
    sources.push({ path, origin });
    for (const c of unit.nodes ?? []) {
      if (c.nodeType !== 'ContractDefinition') continue;
      const functions: Callable[] = [];
      const modifiers: Callable[] = [];
      const storage: StorageVariable[] = [];
      for (const n of c.nodes ?? []) {
        if (n.nodeType === 'FunctionDefinition' || n.nodeType === 'ModifierDefinition') {
          const callable = analyzeCallable(n, c, path, declById, contractById, digestRange);
          (n.nodeType === 'ModifierDefinition' ? modifiers : functions).push(callable);
        } else if (n.nodeType === 'VariableDeclaration') {
          const src = parseSrc(n.src);
          storage.push({ name: n.name, type: paramType(n), visibility: n.visibility, mutability: n.mutability ?? (n.constant ? 'constant' : 'mutable'), src });
          if (n.visibility === 'public') {
            const sig = callableSignature(n).signature;
            functions.push({
              key: `${path}:${c.name}.${sig}`,
              symbol: `${c.name}.${sig}`,
              contract: c.name,
              path,
              name: n.name,
              kind: 'getter',
              signature: sig,
              selector: n.functionSelector ?? null,
              visibility: 'public',
              mutability: 'view',
              virtual: false,
              overrides: !!n.overrides,
              implemented: true,
              modifiers: [],
              internal_calls: [],
              external_calls: [],
              unresolved_calls: [],
              low_level_calls: [],
              assembly: [],
              writes: [],
              reads: [`${c.name}.${n.name}`],
              src,
              content_digest: digestRange(path, src),
            });
          }
        }
      }
      const linearized = (c.linearizedBaseContracts ?? []).map((id: number) => contractById.get(id)?.name ?? `#${id}`);
      const csrc = parseSrc(c.src);
      const all = [...functions, ...modifiers];
      contracts.push({
        name: c.name,
        path,
        origin,
        kind: c.contractKind,
        abstract: !!c.abstract,
        src: csrc,
        content_digest: digestRange(path, csrc),
        bases: (c.baseContracts ?? []).map((b: any) => b.baseName?.name ?? b.baseName?.namePath ?? '?'),
        linearized,
        functions,
        modifiers,
        storage_variables: storage,
        assembly: all.flatMap((f) => f.assembly.map((src) => ({ in: f.symbol, src }))),
        low_level_calls: all.flatMap((f) => f.low_level_calls.map((l) => ({ ...l, in: f.symbol }))),
        entry_points: [],
      });
    }
  }

  // Entry points through linearization (needs every contract first).
  const byName = new Map<string, InventoryContract[]>();
  for (const c of contracts) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const c of contracts) {
    if (c.kind === 'interface') continue;
    const seen = new Set<string>();
    for (const baseName of c.linearized) {
      const base = (byName.get(baseName) ?? [])[0];
      if (!base) continue;
      for (const f of base.functions) {
        if (!(f.visibility === 'external' || f.visibility === 'public')) continue;
        if (f.kind === 'constructor') continue;
        const sig = f.kind === 'fallback' || f.kind === 'receive' ? f.kind : f.signature;
        if (seen.has(sig)) continue;
        seen.add(sig);
        c.entry_points.push({ signature: f.signature, selector: f.selector, declared_in: base.name, kind: f.kind });
      }
    }
    c.entry_points.sort((a, b) => a.signature.localeCompare(b.signature));
  }

  // Storage layouts per compiled contract.
  const layouts: StorageLayouts = { format: 'harness.storage_layouts/1', contracts: {} };
  for (const a of sorted) {
    const sl = a.json?.storageLayout;
    const meta = typeof a.json?.metadata === 'string' ? safeParse(a.json.metadata) : a.json?.metadata;
    const target = meta?.settings?.compilationTarget as Record<string, string> | undefined;
    const [tpath, tname] = target ? Object.entries(target)[0] ?? [] : [];
    if (!tpath || !tname) continue;
    if (!sl || !Array.isArray(sl.storage)) {
      problems.push(`${a.path}: no storageLayout (build without extra_output storageLayout?)`);
      continue;
    }
    const k = `${tpath}:${tname}`;
    if (layouts.contracts[k]) continue;
    layouts.contracts[k] = sl.storage.map((e: any) => ({
      label: e.label,
      slot: String(e.slot),
      offset: Number(e.offset ?? 0),
      type: sl.types?.[e.type]?.label ?? e.type,
      declared_in: (() => {
        const d = declById.get(e.astId);
        return d ? (contractById.get(d.contractId)?.name ?? tname) : tname;
      })(),
    }));
  }

  const compilerList = [...compilers.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (new Set(compilerList.map(([, c]) => JSON.stringify(c))).size > 1) {
    problems.push(`artifacts were produced with more than one compiler configuration: ${compilerList.map(([, c]) => `${c.version}/${c.evm_version}`).join(', ')}`);
  }
  contracts.sort((a, b) => (a.path + ':' + a.name).localeCompare(b.path + ':' + b.name));
  return {
    inventory: { format: 'harness.inventory/1', compiler: compilerList[0]?.[1] ?? null, sources, contracts, problems },
    layouts,
  };
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function analyzeCallable(
  n: any,
  c: any,
  path: string,
  declById: Map<number, DeclInfo>,
  contractById: Map<number, { name: string; path: string }>,
  digestRange: (path: string, r: SrcRange) => string | null,
): Callable {
  const s = callableSignature(n);
  const src = parseSrc(n.src);
  const out: Callable = {
    key: `${path}:${c.name}.${s.signature}`,
    symbol: `${c.name}.${s.signature}`,
    contract: c.name,
    path,
    name: s.name,
    kind: s.kind,
    signature: s.signature,
    selector: n.functionSelector ?? null,
    visibility: n.visibility ?? 'internal',
    mutability: n.stateMutability ?? null,
    virtual: !!n.virtual,
    overrides: !!n.overrides,
    implemented: n.nodeType === 'ModifierDefinition' ? !!n.body : !!n.implemented,
    modifiers: [],
    internal_calls: [],
    external_calls: [],
    unresolved_calls: [],
    low_level_calls: [],
    assembly: [],
    writes: [],
    reads: [],
    src,
    content_digest: digestRange(path, src),
  };
  const stateVar = (e: any): string | null => {
    let x = e;
    while (x && (x.nodeType === 'IndexAccess' || x.nodeType === 'MemberAccess' || x.nodeType === 'IndexRangeAccess')) {
      const inner = x.nodeType === 'MemberAccess' ? x.expression : x.baseExpression;
      // `a.b` where `a` is itself a state variable (struct member write) or `this.x` style access.
      if (x.nodeType === 'MemberAccess' && typeof x.referencedDeclaration === 'number' && declById.get(x.referencedDeclaration)?.kind === 'variable' && !inner?.referencedDeclaration) {
        x = { nodeType: 'Identifier', referencedDeclaration: x.referencedDeclaration };
        break;
      }
      x = inner;
    }
    if (x?.nodeType !== 'Identifier' || typeof x.referencedDeclaration !== 'number') return null;
    const d = declById.get(x.referencedDeclaration);
    if (!d || d.kind !== 'variable') return null;
    return `${contractById.get(d.contractId)?.name ?? '?'}.${d.name}`;
  };
  const writes = new Set<string>();
  const reads = new Set<string>();
  forEachNode(n.body, (x) => {
    if (x.nodeType === 'Identifier' && typeof x.referencedDeclaration === 'number') {
      const v = stateVar(x);
      if (v) reads.add(v);
    } else if (x.nodeType === 'Assignment') {
      const v = stateVar(x.leftHandSide);
      if (v) writes.add(v);
      if (x.leftHandSide?.nodeType === 'TupleExpression') for (const c of x.leftHandSide.components ?? []) {
        const w = c ? stateVar(c) : null;
        if (w) writes.add(w);
      }
    } else if (x.nodeType === 'UnaryOperation' && (x.operator === '++' || x.operator === '--' || x.operator === 'delete')) {
      const v = stateVar(x.subExpression);
      if (v) writes.add(v);
    } else if (x.nodeType === 'FunctionCall' && x.expression?.nodeType === 'MemberAccess' && (x.expression.memberName === 'push' || x.expression.memberName === 'pop')) {
      const v = stateVar(x.expression.expression);
      if (v) writes.add(v);
    }
  });
  out.writes = [...writes].sort();
  out.reads = [...reads].sort();
  for (const m of n.modifiers ?? []) {
    const id = m.modifierName?.referencedDeclaration;
    if (m.kind === 'baseConstructorSpecifier') {
      const base = contractById.get(id);
      if (base) out.internal_calls.push({ ref: `${base.path}:${base.name}.constructor()`, name: 'constructor', signature: 'constructor()', virtual: false });
      continue;
    }
    const d = declById.get(id);
    out.modifiers.push({ name: m.modifierName?.name ?? '?', ref: d?.key ?? null, virtual: d?.virtual ?? false });
  }
  const edges = new Set<string>();
  const addEdge = (d: DeclInfo) => {
    if (edges.has(d.key)) return;
    edges.add(d.key);
    out.internal_calls.push({ ref: d.key, name: d.name, signature: d.signature, virtual: d.virtual });
  };
  forEachNode(n.body, (x) => {
    if (x.nodeType === 'InlineAssembly') {
      out.assembly.push(parseSrc(x.src));
      forEachNode(x.AST, (y) => {
        if (y.nodeType === 'YulFunctionCall' && YUL_CALLS.has(y.functionName?.name)) {
          out.low_level_calls.push({ kind: y.functionName.name, target: 'assembly', in_assembly: true, src: parseSrc(y.src) });
        }
      });
      return false;
    }
    if (x.nodeType !== 'FunctionCall' || x.kind !== 'functionCall') return;
    let e = x.expression;
    if (e?.nodeType === 'FunctionCallOptions') e = e.expression;
    if (e?.nodeType === 'MemberAccess') {
      const baseType: string = e.expression?.typeDescriptions?.typeString ?? '';
      if (LOW_LEVEL.has(e.memberName) && /^address/.test(baseType)) {
        out.low_level_calls.push({ kind: e.memberName, target: describe(e.expression), in_assembly: false, src: parseSrc(x.src) });
        return;
      }
      const d = typeof e.referencedDeclaration === 'number' ? declById.get(e.referencedDeclaration) : undefined;
      if (d && d.kind !== 'variable') {
        const external = /^contract /.test(baseType) && describe(e.expression) !== 'this';
        if (external) out.external_calls.push(`${baseType.replace(/^contract /, '')}.${e.memberName} via ${describe(e.expression)}`);
        else addEdge(d);
        return;
      }
      if (d && d.kind === 'variable') {
        // Public getter of another contract instance.
        if (/^contract /.test(baseType) && describe(e.expression) !== 'this') out.external_calls.push(`${baseType.replace(/^contract /, '')}.${e.memberName} via ${describe(e.expression)}`);
        return;
      }
      if (/^struct /.test(baseType) && e.referencedDeclaration === undefined) {
        out.unresolved_calls.push(`call through function-typed member ${describe(e)}`);
      }
      return;
    }
    if (e?.nodeType === 'Identifier') {
      const ref = e.referencedDeclaration;
      if (typeof ref !== 'number' || ref < 0) return;
      const d = declById.get(ref);
      if (d && d.kind !== 'variable') addEdge(d);
      else if (d && d.kind === 'variable') out.unresolved_calls.push(`call through function-typed variable ${e.name}`);
      else if (/^function /.test(e.typeDescriptions?.typeString ?? '')) out.unresolved_calls.push(`call through function-typed value ${e.name}`);
      return;
    }
    if (e && e.nodeType !== 'NewExpression' && e.nodeType !== 'ElementaryTypeNameExpression') {
      out.unresolved_calls.push(`call through ${describe(e)}`);
    }
  });
  return out;
}

// ------------------------------------------------------------------------------------------------
// Lookups used by probes and diffs

export function findContract(inv: Inventory, name: string, path?: string | null): InventoryContract | null {
  const m = inv.contracts.filter((c) => c.name === name && (!path || c.path === path));
  return m.length === 1 ? m[0] : m.find((c) => c.origin === 'source') ?? m[0] ?? null;
}

export function callableByKey(inv: Inventory): Map<string, Callable> {
  const m = new Map<string, Callable>();
  for (const c of inv.contracts) for (const f of [...c.functions, ...c.modifiers]) m.set(f.key, f);
  return m;
}

/**
 * Resolve `Contract.name` or `Contract.name(sig)` through the contract's linearization (so an
 * inherited function or modifier is found from the derived contract). Returns null when absent;
 * throws a string reason when the name is ambiguous.
 */
export function resolveSymbol(inv: Inventory, symbol: string, path?: string | null): { contract: InventoryContract; callable: Callable | null } | { error: string } {
  const dot = symbol.indexOf('.');
  const cname = dot < 0 ? symbol : symbol.slice(0, dot);
  const member = dot < 0 ? null : symbol.slice(dot + 1);
  const contract = findContract(inv, cname, path);
  if (!contract) return { error: `contract ${cname} is not in the inventory` };
  if (!member) return { contract, callable: null };
  const hasSig = member.includes('(');
  const name = hasSig ? member.slice(0, member.indexOf('(')) : member;
  for (const baseName of contract.linearized.length ? contract.linearized : [contract.name]) {
    const base = baseName === contract.name ? contract : findContract(inv, baseName);
    if (!base) continue;
    const cands = [...base.functions, ...base.modifiers].filter((f) => (hasSig ? f.signature === member : f.name === name));
    if (cands.length > 1) return { error: `${symbol} is ambiguous (${cands.map((f) => f.signature).join(', ')}); give the signature` };
    if (cands.length === 1) return { contract, callable: cands[0] };
  }
  return { error: `${symbol} is not declared in ${cname} or its bases` };
}

/** Resolve a virtual callee for the most-derived contract `ctx` (first definition in its linearization). */
export function resolveVirtual(inv: Inventory, ctx: InventoryContract, name: string, signature: string, isModifier: boolean): Callable | null {
  for (const baseName of ctx.linearized) {
    const base = findContract(inv, baseName);
    if (!base) continue;
    const list = isModifier ? base.modifiers : base.functions;
    const f = list.find((x) => x.signature === signature && x.implemented);
    if (f) return f;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Reading a build output tree from the archive

export function readOutArtifacts(archive: Archive, outTree: string): { artifacts: ArtifactFile[]; problems: string[] } {
  const m = archive.getTree(outTree);
  const artifacts: ArtifactFile[] = [];
  const problems: string[] = [];
  for (const [path, d] of Object.entries(m.files).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!path.endsWith('.json') || path.startsWith('build-info/') || path.includes('/build-info/')) continue;
    try {
      artifacts.push({ path, json: JSON.parse(archive.getText(d)) });
    } catch (e) {
      problems.push(`${path}: unreadable artifact (${(e as Error).message})`);
    }
  }
  for (const r of m.refused) problems.push(`${r.path}: ${r.reason}`);
  return { artifacts, problems };
}
