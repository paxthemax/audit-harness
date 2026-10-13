import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, fstatSync, constants as fsc } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../core/hash.ts';

// Portable bundle layout and verification (design/harness-interface-contracts.md, "Portable report and
// PoC package"). A bundle is a directory (or a ustar archive of one):
//
//   README.md, manifest.json, report.md, records/, artifacts/, reproduction/   the hashed payload
//   release-receipt.json                                                       outside the payload
//
// manifest.json lists every other payload file with its digest, so the payload identity is the
// digest of manifest.json. Recipients check each hash; a checksum is not a signature.
//
// Reading is strictly passive: files are read as bytes, nothing is executed, extracted or installed.
// Symlinks, hard links, devices, absolute paths, `..` components and archive entries that would
// escape are refused. Numeric limits below are proposed defaults (operator choices, not decided).

export const BUNDLE_FORMAT = 'harness.export/1';
export const RECEIPT_PATH = 'release-receipt.json';
export const MANIFEST_PATH = 'manifest.json';
export const MAX_BUNDLE_FILES = 20000;
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export interface BundleFiles {
  files: Map<string, Buffer>;
  refused: { path: string; reason: string }[];
}

/** A relative POSIX path that stays inside the bundle; returns the reason when it is unsafe. */
export function unsafePath(p: string): string | null {
  if (typeof p !== 'string' || !p.length) return 'empty path';
  if (p.includes('\0')) return 'NUL in path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
  const parts = p.split('/');
  if (parts.some((s) => s === '..')) return 'parent-directory component';
  if (parts.some((s) => s === '' || s === '.')) return 'non-normalized path';
  if (p.length > 1024) return 'path too long';
  return null;
}

/** Read a bundle directory without following links. */
export function readBundleDir(root: string): BundleFiles {
  const files = new Map<string, Buffer>();
  const refused: { path: string; reason: string }[] = [];
  let total = 0;
  const rootSt = lstatSync(root);
  if (rootSt.isSymbolicLink()) return { files, refused: [{ path: '.', reason: 'bundle root is a symlink' }] };
  if (!rootSt.isDirectory()) return { files, refused: [{ path: '.', reason: 'bundle root is not a directory' }] };
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      const st = lstatSync(p);
      const bad = unsafePath(r);
      if (bad) refused.push({ path: r, reason: bad });
      else if (st.isSymbolicLink()) refused.push({ path: r, reason: 'symlink refused' });
      else if (st.isDirectory()) walk(p, r);
      else if (!st.isFile()) refused.push({ path: r, reason: 'special file refused' });
      else if (st.nlink > 1) refused.push({ path: r, reason: 'hard-linked file refused' });
      else {
        if (files.size >= MAX_BUNDLE_FILES) {
          refused.push({ path: r, reason: 'file-count limit exceeded' });
          continue;
        }
        total += st.size;
        if (total > MAX_BUNDLE_BYTES) {
          refused.push({ path: r, reason: 'size limit exceeded' });
          continue;
        }
        // O_NOFOLLOW: a file swapped for a symlink after lstat is still refused.
        const fd = openSync(p, fsc.O_RDONLY | fsc.O_NOFOLLOW);
        try {
          const size = fstatSync(fd).size;
          const buf = Buffer.alloc(size);
          let off = 0;
          while (off < size) {
            const n = readSync(fd, buf, off, size - off, off);
            if (n === 0) break;
            off += n;
          }
          files.set(r, buf.subarray(0, off));
        } finally {
          closeSync(fd);
        }
      }
    }
  };
  walk(root, '');
  return { files, refused };
}

/**
 * Parse a ustar archive in memory. Only regular files and directories are accepted; links, devices,
 * FIFOs, pax/GNU extension headers and any escaping name are refused. Nothing is written to disk.
 */
export function readBundleTar(path: string): BundleFiles {
  const data = readFileSync(path);
  const files = new Map<string, Buffer>();
  const refused: { path: string; reason: string }[] = [];
  if (data.length > MAX_BUNDLE_BYTES) return { files, refused: [{ path: '.', reason: 'size limit exceeded' }] };
  const str = (b: Buffer) => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString('utf8');
  };
  let off = 0;
  while (off + 512 <= data.length) {
    const h = data.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = str(h.subarray(0, 100));
    const sizeField = str(h.subarray(124, 136)).trim();
    const type = String.fromCharCode(h[156] || 0x30);
    const magic = str(h.subarray(257, 263));
    const prefix = magic.startsWith('ustar') ? str(h.subarray(345, 500)) : '';
    // Header checksum: sum of header bytes with the checksum field taken as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    const declared = parseInt(str(h.subarray(148, 156)).trim(), 8);
    if (!/^[0-7]*$/.test(sizeField) || declared !== sum) {
      refused.push({ path: name || '?', reason: 'corrupt tar header' });
      break;
    }
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
    const rel = type === '5' ? full.replace(/\/+$/, '') : full;
    const bodyStart = off + 512;
    off = bodyStart + Math.ceil(size / 512) * 512;
    if (bodyStart + size > data.length) {
      refused.push({ path: rel, reason: 'truncated tar entry' });
      break;
    }
    const bad = unsafePath(rel);
    if (type === '5') {
      if (bad && rel !== '') refused.push({ path: rel, reason: bad });
      continue;
    }
    if (type === '2') refused.push({ path: rel, reason: 'symlink refused' });
    else if (type === '1') refused.push({ path: rel, reason: 'hard link refused' });
    else if (type === 'x' || type === 'g' || type === 'L' || type === 'K') refused.push({ path: rel, reason: 'extended tar headers are not supported' });
    else if (type !== '0' && type !== '7') refused.push({ path: rel, reason: `tar entry type ${JSON.stringify(type)} refused` });
    else if (bad) refused.push({ path: rel, reason: bad });
    else if (files.has(rel)) refused.push({ path: rel, reason: 'duplicate entry' });
    else if (files.size >= MAX_BUNDLE_FILES) refused.push({ path: rel, reason: 'file-count limit exceeded' });
    else files.set(rel, Buffer.from(data.subarray(bodyStart, bodyStart + size)));
  }
  return { files, refused };
}

export interface BundleManifest {
  format: string;
  engagement: { id: string; name: string };
  files: Record<string, string>;
  [k: string]: unknown;
}

export interface BundleVerification {
  ok: boolean;
  payload: string | null;
  manifest: BundleManifest | null;
  problems: string[];
  receipt: Record<string, unknown> | null;
}

/** Check every payload hash and path; the release receipt is outside the payload. */
export function verifyBundleFiles(b: BundleFiles): BundleVerification {
  const problems = b.refused.map((r) => `${r.path}: ${r.reason}`);
  const raw = b.files.get(MANIFEST_PATH);
  if (!raw) return { ok: false, payload: null, manifest: null, problems: [...problems, 'manifest.json missing'], receipt: null };
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, payload: null, manifest: null, problems: [...problems, 'manifest.json is not JSON'], receipt: null };
  }
  if (!manifest || manifest.format !== BUNDLE_FORMAT || typeof manifest.files !== 'object' || !manifest.files) {
    return { ok: false, payload: null, manifest: null, problems: [...problems, 'manifest.json has an unsupported format'], receipt: null };
  }
  const payload = digest(raw);
  for (const [p, d] of Object.entries(manifest.files)) {
    const bad = unsafePath(p);
    if (bad) problems.push(`manifest entry ${p}: ${bad}`);
    else if (p === RECEIPT_PATH || p === MANIFEST_PATH) problems.push(`manifest entry ${p} is not a payload file`);
    else if (!b.files.has(p)) problems.push(`${p}: missing`);
    else if (digest(b.files.get(p)!) !== d) problems.push(`${p}: hash mismatch`);
  }
  for (const p of b.files.keys()) {
    if (p !== MANIFEST_PATH && p !== RECEIPT_PATH && !(p in manifest.files)) problems.push(`${p}: not listed in the manifest`);
  }
  let receipt: Record<string, unknown> | null = null;
  const rr = b.files.get(RECEIPT_PATH);
  if (rr) {
    try {
      receipt = JSON.parse(rr.toString('utf8'));
      if (receipt?.payload !== payload) problems.push('release-receipt.json names a different payload');
    } catch {
      problems.push('release-receipt.json is not JSON');
    }
  }
  return { ok: problems.length === 0, payload, manifest, problems, receipt };
}

/** Verify a bundle directory or ustar file as a recipient would. */
export function verifyBundle(path: string): BundleVerification {
  const st = lstatSync(path);
  return verifyBundleFiles(st.isFile() ? readBundleTar(path) : readBundleDir(path));
}
