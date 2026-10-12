import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { digest, isDigest } from '../core/hash.ts';
import { fail } from '../core/errors.ts';
import type { ArtifactRef } from '../core/refs.ts';

// Evidence archive: immutable files addressed by content hash. Blobs are hashed and durably stored
// before a metadata transaction makes them eligible; an unreferenced blob is retained for recovery
// but is never evidence (design/harness-state-and-execution.md, "Write and approval protocol").

export interface TreeManifest {
  format: 'harness.tree/1';
  files: Record<string, string>; // relative POSIX path -> digest
  /** Entries refused at ingestion (symlinks, special files) with the reason. */
  refused: { path: string; reason: string }[];
}

export class Archive {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, 'sha256'), { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
  }

  pathOf(d: string): string {
    if (!isDigest(d)) fail('invalid_request', `not a digest: ${d}`);
    const hex = d.slice(7);
    return join(this.root, 'sha256', hex.slice(0, 2), hex);
  }

  has(d: string): boolean {
    return existsSync(this.pathOf(d));
  }

  put(data: string | Uint8Array): ArtifactRef {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const d = digest(bytes);
    const target = this.pathOf(d);
    if (existsSync(target)) {
      this.get(d); // verify the existing copy
      return { artifact: d };
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(this.root, 'tmp', `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const fd = openSync(tmp, 'wx', 0o444);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    return { artifact: d };
  }

  putJson(value: unknown): ArtifactRef {
    return this.put(JSON.stringify(value, null, 2) + '\n');
  }

  putFile(path: string): ArtifactRef {
    return this.put(readFileSync(path));
  }

  /** Read and verify; a mismatch is an integrity failure, never silently served. */
  get(d: string): Buffer {
    const p = this.pathOf(d);
    if (!existsSync(p)) fail('artifact_incomplete', `artifact ${d} is not in the archive`, { ref: { artifact: d } });
    const bytes = readFileSync(p);
    if (digest(bytes) !== d) fail('integrity_failure', `artifact ${d} does not match its hash`, { ref: { artifact: d } });
    return bytes;
  }

  getText(d: string): string {
    return this.get(d).toString('utf8');
  }

  getJson<T = unknown>(d: string): T {
    return JSON.parse(this.getText(d)) as T;
  }

  /**
   * Hash every regular file under `dir` into the archive and return the manifest's ref.
   * Symlinks and special files are refused (recorded in the manifest), and nothing outside `dir` is read.
   */
  putTree(dir: string, filter: (rel: string) => boolean = () => true): { ref: ArtifactRef; manifest: TreeManifest } {
    const root = resolve(dir);
    const files: Record<string, string> = {};
    const refused: { path: string; reason: string }[] = [];
    const walk = (abs: string) => {
      for (const name of readdirSync(abs).sort()) {
        const p = join(abs, name);
        const rel = relative(root, p).split(sep).join('/');
        if (!filter(rel)) continue;
        const st = lstatSync(p);
        if (st.isSymbolicLink()) refused.push({ path: rel, reason: 'symlink refused at ingestion' });
        else if (st.isDirectory()) walk(p);
        else if (st.isFile()) files[rel] = this.putFile(p).artifact;
        else refused.push({ path: rel, reason: 'special file refused at ingestion' });
      }
    };
    walk(root);
    const manifest: TreeManifest = { format: 'harness.tree/1', files, refused };
    return { ref: this.putJson(manifest), manifest };
  }

  getTree(d: string): TreeManifest {
    const m = this.getJson<TreeManifest>(d);
    if (m.format !== 'harness.tree/1') fail('integrity_failure', `artifact ${d} is not a tree manifest`);
    return m;
  }

  /** Write a tree's files under `dest` (which must be empty or absent). Paths are checked for escape. */
  materialize(treeDigest: string, dest: string, writable = false): void {
    const m = this.getTree(treeDigest);
    const base = resolve(dest);
    mkdirSync(base, { recursive: true });
    for (const [rel, d] of Object.entries(m.files)) {
      const target = resolve(base, rel);
      if (!target.startsWith(base + sep)) fail('integrity_failure', `tree path escapes destination: ${rel}`);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(this.pathOf(d), target);
      chmodSync(target, writable ? 0o644 : 0o444);
      this.get(d);
    }
  }

  /** Verify every blob; returns digests that fail. */
  verifyAll(): string[] {
    const bad: string[] = [];
    const base = join(this.root, 'sha256');
    for (const pre of readdirSync(base)) {
      for (const hex of readdirSync(join(base, pre))) {
        const d = `sha256:${hex}`;
        try {
          this.get(d);
        } catch {
          bad.push(d);
        }
      }
    }
    return bad;
  }
}
