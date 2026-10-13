import { renderVisible } from './visible.ts';

// Terminal IO seam for the trusted decision screen. The screen logic talks only to this interface,
// so its rendering and state can be tested with injected IO; `tty.ts` supplies the real driver.
// Every string that came from a record, an artifact or an agent passes through `renderVisible`
// before it is written (`show`), so deceptive characters and escape sequences cannot act on the
// terminal. Only the screen's own fixed labels use `write` directly.

export interface ScreenIO {
  /** True only when both input and output are an interactive terminal. */
  readonly interactive: boolean;
  /** Terminal rows available for paging. */
  readonly rows: number;
  /** Whether bold/inverse emphasis may be used (never the only carrier of meaning). */
  readonly styled: boolean;
  /** Write trusted screen text (labels, prompts); callers must not pass record content here. */
  write(s: string): void;
  /** Read one line; resolves to the line without its newline; rejects with InputClosed at end of input. */
  ask(prompt: string): Promise<string>;
  /** Multi-line text entry, optionally starting from `initial` (an agent draft to edit). */
  edit(label: string, initial: string): Promise<string>;
  close(): void;
}

/** Input ended (EOF / Ctrl-D) while the screen or wrapper waited: nothing further is recorded. */
export class InputClosed extends Error {
  constructor() {
    super('input closed');
    this.name = 'InputClosed';
  }
}

/** Write untrusted content (record text, artifacts, agent prose) with deceptive characters visible. */
export function show(io: ScreenIO, s: string): void {
  io.write(renderVisible(s));
}

export function bold(io: ScreenIO, s: string): string {
  return io.styled ? `\x1b[1m${s}\x1b[0m` : s;
}

export function heading(io: ScreenIO, s: string): void {
  io.write('\n' + bold(io, `== ${s} ==`) + '\n');
}

/** Show lines, paging long content: the requested decision stays one key away (Enter / q). */
export async function page(io: ScreenIO, lines: string[], title: string): Promise<void> {
  const size = Math.max(5, io.rows - 4);
  heading(io, `${title} (${lines.length} lines)`);
  for (let i = 0; i < lines.length; i += size) {
    show(io, lines.slice(i, i + size).join('\n') + '\n');
    if (i + size >= lines.length) break;
    const a = (await io.ask(`-- lines ${i + 1}-${i + size} of ${lines.length}; Enter for more, q to return -- `)).trim();
    if (a === 'q') break;
  }
  io.write(`-- end of ${title}; back to the decision --\n`);
}

/** Ask until `valid` accepts the answer. */
export async function askUntil(io: ScreenIO, prompt: string, valid: (a: string) => string | null): Promise<string> {
  for (;;) {
    const a = (await io.ask(prompt)).trim();
    const problem = valid(a);
    if (problem === null) return a;
    io.write(`  ${problem}\n`);
  }
}

/** Choose one of the listed options by its key. Keys are shown with their full labels. */
export async function choose<T extends string>(
  io: ScreenIO,
  prompt: string,
  options: { key: string; value: T; label: string }[],
): Promise<T> {
  for (const o of options) io.write(`  [${o.key}] ${o.label}\n`);
  const a = await askUntil(io, `${prompt} (${options.map((o) => o.key).join('/')}): `, (x) =>
    options.some((o) => o.key === x) ? null : `Enter one of: ${options.map((o) => o.key).join(', ')}`,
  );
  return options.find((o) => o.key === a)!.value;
}

/** Lines until an empty line. */
export async function askList(io: ScreenIO, prompt: string): Promise<string[]> {
  io.write(`${prompt} (one per line; empty line to finish)\n`);
  const out: string[] = [];
  for (;;) {
    const a = (await io.ask('  > ')).trim();
    if (!a) return out;
    out.push(a);
  }
}

/** Explicit confirmation: the auditor must type the word, not just press Enter. */
export async function confirmWord(io: ScreenIO, prompt: string, word = 'yes'): Promise<boolean> {
  const a = (await io.ask(`${prompt} Type "${word}" to confirm, anything else to cancel: `)).trim();
  return a === word;
}
