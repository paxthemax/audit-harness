import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { InputClosed, type ScreenIO } from './io.ts';
import { renderVisible } from './visible.ts';

// The real terminal driver for the trusted decision screen. `interactive` is true only when both
// stdin and stdout are TTYs; `openTrustedScreen` refuses to start otherwise. Multi-line entry uses
// $VISUAL/$EDITOR on a private temporary file when one is set, or line entry ended by a lone ".".

export function ttyIO(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): ScreenIO {
  const interactive = !!input.isTTY && !!output.isTTY;
  // Lines are queued as they arrive, so input typed (or pasted) ahead of the next prompt is never lost.
  let rl: Interface | null = null;
  const queued: string[] = [];
  let waiter: { res: (s: string) => void; rej: (e: Error) => void } | null = null;
  let closed = false;
  const line = (): Interface => {
    if (rl) return rl;
    rl = createInterface({ input, output, terminal: interactive });
    rl.on('line', (l) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.res(l);
      } else queued.push(l);
    });
    rl.on('close', () => {
      closed = true;
      if (waiter) waiter.rej(new InputClosed());
      waiter = null;
    });
    return rl;
  };
  const ask = (prompt: string) =>
    new Promise<string>((res, rej) => {
      const r = line();
      r.setPrompt(prompt);
      r.prompt();
      if (queued.length) {
        output.write('\n');
        res(queued.shift()!);
      } else if (closed) rej(new InputClosed());
      else waiter = { res, rej };
    });
  return {
    interactive,
    rows: output.rows ?? 24,
    styled: interactive && !process.env.NO_COLOR,
    write: (s) => void output.write(s),
    ask,
    async edit(label, initial) {
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (editor && interactive) {
        const dir = mkdtempSync(join(tmpdir(), 'harness-screen-'));
        const file = join(dir, 'text.txt');
        try {
          writeFileSync(file, initial, { mode: 0o600 });
          line().pause();
          const r = spawnSync(editor, [file], { stdio: 'inherit', shell: false });
          line().resume();
          if (r.status !== 0) output.write(`Editor exited with status ${r.status}; falling back to line entry.\n`);
          else return readFileSync(file, 'utf8').replace(/\n$/, '');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      output.write(`${label}. Enter text; a line with a single "." ends it.\n`);
      if (initial) output.write(`Current text (shown visibly; retype the full text to change it, or enter "." alone to keep it):\n${renderVisible(initial)}\n`);
      const lines: string[] = [];
      for (;;) {
        const l = await ask('| ');
        if (l === '.') break;
        lines.push(l);
      }
      return lines.length ? lines.join('\n') : initial;
    },
    close() {
      rl?.close();
    },
  };
}
