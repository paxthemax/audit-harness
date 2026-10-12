import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../src/index.ts';
import { Controller, type Session } from '../src/controller/controller.ts';
import { Workspace } from '../src/controller/workspace.ts';

export interface Harness {
  dir: string;
  ws: Workspace;
  controller: Controller;
  auditor: Session;
  screen: Session;
  capture: Session;
  system: Session;
  runner: Session;
  cleanup(): void;
}

/** A fresh workspace in a temp dir with authenticated sessions for each channel. */
export function makeHarness(opts: { clock?: () => Date } = {}): Harness {
  const dir = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-test-'));
  const ws = Workspace.init(join(dir, 'ws'));
  const controller = new Controller(ws, { clock: opts.clock });
  const key = ws.readSecret('auditor.key');
  return {
    dir,
    ws,
    controller,
    auditor: controller.auditor(key),
    screen: controller.screen(key, 'test-screen', 'test-session'),
    capture: controller.capture(ws.readSecret('capture.key'), 'test-capture', 'sha256:' + '0'.repeat(64), 'cap-session'),
    system: controller.system(),
    runner: controller.runner(),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function newEngagement(h: Harness, id = 'eng-test'): string {
  h.auditor.do(id, 'create_engagement', { name: 'Test engagement', owner: 'auditor', audit_purpose: 'test' });
  return id;
}
