import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, digestJson } from '../core/hash.ts';

// Program identity for channels that must sit outside the model's control (capture wrapper, hook,
// trusted screen). The identity is a digest over the channel's own program files, so a captured-input
// record or display receipt names exactly which code produced it. It does not cover the Node runtime
// or the shared controller/store modules these programs import; those are part of the trusted
// installation whose integrity the operator verifies (docs/cli.md, "Confinement conditions").

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tsFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
}

/** Digest of `{files: {relative path: sha256}}` over the given repository-relative files. */
export function programDigest(files: string[]): string {
  const manifest: Record<string, string> = {};
  for (const f of [...files].sort()) manifest[relative(REPO_ROOT, resolve(REPO_ROOT, f))] = digest(readFileSync(resolve(REPO_ROOT, f)));
  return digestJson({ files: manifest });
}

/** Files of the capture channel program: launcher, CLI entry point and the capture module. */
export function captureProgramFiles(): string[] {
  return ['bin/harness', 'src/cli/main.ts', ...tsFiles('src/capture')];
}

/** Files of the trusted decision screen program. */
export function screenProgramFiles(): string[] {
  return ['bin/harness', 'src/cli/main.ts', ...tsFiles('src/screen')];
}

let captureDigestCache: string | null = null;
let screenDigestCache: string | null = null;

export function captureProgramDigest(): string {
  return (captureDigestCache ??= programDigest(captureProgramFiles()));
}

export function screenProgramDigest(): string {
  return (screenDigestCache ??= programDigest(screenProgramFiles()));
}
