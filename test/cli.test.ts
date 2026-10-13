import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORD_TYPES } from '../src/schema/records.ts';
import { main } from '../src/cli/main.ts';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness');

function harness(dir: string, args: string[], input?: string) {
  const r = spawnSync(BIN, args, {
    env: { ...process.env, HARNESS_WORKSPACE: join(dir, 'ws'), HARNESS_ENGAGEMENT: '' },
    input: input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('CLI end to end: init, engagement create, records, status, schemas, refusals, capture-hook', () => {
  const dir = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-cli-'));
  try {
    let r = harness(dir, ['init']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'ws', 'secrets', 'auditor.key')));
    assert.ok(!r.stdout.includes(readFileSync(join(dir, 'ws', 'secrets', 'auditor.key'), 'utf8').trim()), 'init must not print the key');

    r = harness(dir, ['engagement', 'create', 'demo', '--name', 'Demo ‮vault', '--owner', 'auditor', '--purpose', 'pilot', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).result.engagement, { record_id: 'eng-0001', revision: 1 });

    r = harness(dir, ['records', '-e', 'demo', '--type', 'engagement', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const recs = JSON.parse(r.stdout);
    assert.equal(recs.records.length, 1);
    assert.equal(recs.records[0].body.name, 'Demo ‮vault');

    // Human output renders deceptive characters visibly.
    r = harness(dir, ['show', 'eng-0001@1', '-e', 'demo']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('‮'));
    assert.match(r.stdout, /⟦U\+202E/);

    r = harness(dir, ['status', '-e', 'demo', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const home = JSON.parse(r.stdout);
    assert.ok(home.decisions_needed.some((d: { what: string }) => /Scope and policy/.test(d.what)));
    assert.ok(home.material_gaps.some((g: string) => /No target snapshot/.test(g)));

    r = harness(dir, ['schemas', '--out', join(dir, 'schemas')]);
    assert.equal(r.code, 0, r.stderr);
    for (const t of RECORD_TYPES) {
      const s = JSON.parse(readFileSync(join(dir, 'schemas', 'records', `${t}.schema.json`), 'utf8'));
      assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(s.type, 'object');
    }
    for (const f of ['envelope', 'event', 'request', 'ref']) assert.ok(existsSync(join(dir, 'schemas', `${f}.schema.json`)));
    assert.equal(JSON.parse(readFileSync(join(dir, 'schemas', 'index.json'), 'utf8')).record_types.length, RECORD_TYPES.length);

    // The trusted screen refuses a non-interactive session; decisions cannot go through `call`.
    r = harness(dir, ['screen', 'confirm_interpretations', '-e', 'demo']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /permission_denied[\s\S]*interactive terminal[\s\S]*committed: no/);
    r = harness(dir, ['call', 'record_decision', '-e', 'demo', '--payload', '{}', '--json']);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.stdout).error.code, 'permission_denied');
    r = harness(dir, ['capture', '-e', 'demo']);
    assert.equal(r.code, 3);

    // Usage errors exit 2; controller refusals print the code, reason, commit status and next action.
    assert.equal(harness(dir, ['no-such-command']).code, 2);
    r = harness(dir, ['engagement', 'create', 'demo', '--name', 'x', '--owner', 'y', '--purpose', 'z']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /error: invalid_request[\s\S]*reason: [\s\S]*committed: no[\s\S]*next: Correct the request/);

    // Claude Code UserPromptSubmit hook: verbatim capture, nothing on stdout, exit 0.
    const prompt = 'Fee-on-transfer tokens are unsupported.\nSecond line  ';
    r = harness(dir, ['capture-hook', '-e', 'demo'], JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    r = harness(dir, ['records', '-e', 'demo', '--type', 'captured_input', '--json']);
    assert.equal(JSON.parse(r.stdout).records[0].body.text, prompt);
    // A failing hook still exits 0 with nothing on stdout.
    r = harness(dir, ['capture-hook', '-e', 'no-such-eng'], JSON.stringify({ prompt: 'x' }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /capture FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the CLI in-process and capture its output. */
async function run(ws: string, args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { ...process.env, HARNESS_WORKSPACE: ws, HARNESS_ENGAGEMENT: '' }, { stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

test('records/show withhold IMPLEMENTED behavior during read-first mode and receipt its presentation otherwise', async () => {
  const dir = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-cli-rf-'));
  const ws = join(dir, 'ws');
  try {
    assert.equal((await run(ws, ['init'])).code, 0);
    assert.equal((await run(ws, ['engagement', 'create', 'rf', '--name', 'RF', '--owner', 'a', '--purpose', 'p'])).code, 0);
    const unit = (await run(ws, ['unit', 'propose', '-e', 'rf', '--set', 'kind=flow', '--set', 'name=withdrawal', '--json'])).json().result.audit_unit;
    const body = (affiliation: string, statement: string) =>
      JSON.stringify({ kind: 'observed_implementation', affiliation, origin: 'source_analysis', statement, audit_units: [unit] });
    let r = await run(ws, ['statement', 'propose', '-e', 'rf', '--body', body('implemented', 'withdraw pays before updating the balance'), '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const impl = r.json().records[0];
    assert.equal((await run(ws, ['statement', 'propose', '-e', 'rf', '--body', body('designed', 'withdraw pays at most the balance')])).code, 0);
    assert.equal((await run(ws, ['call', 'start_read_first', '-e', 'rf'])).code, 0);

    // Read-first: the implemented statement is withheld from records, show and call read_records.
    r = await run(ws, ['records', '-e', 'rf', '--type', 'system_statement', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().records.map((x: { body: { affiliation: string } }) => x.body.affiliation), ['designed']);
    assert.deepEqual(r.json().withheld.map((x: { record_id: string }) => x.record_id), [impl.record_id]);
    r = await run(ws, ['records', '-e', 'rf', '--type', 'system_statement']);
    assert.ok(!r.stdout.includes('pays before updating'));
    assert.match(r.stdout, /withheld: read-first mode is active/);
    r = await run(ws, ['show', impl.record_id, '-e', 'rf']);
    assert.equal(r.code, 3);
    assert.ok(!r.stdout.includes('pays before updating'));
    assert.match(r.stderr, /permission_denied[\s\S]*end_read_first/);
    r = await run(ws, ['call', 'read_records', '-e', 'rf', '--payload', '{"type":"system_statement"}', '--json']);
    assert.equal(r.json().result.withheld.length, 1);
    assert.ok(!r.stdout.includes('pays before updating'));
    r = await run(ws, ['records', '-e', 'rf', '--type', 'display_receipt', '--json']);
    assert.equal(r.json().records.length, 0);

    // After read-first ends, presenting it records a display receipt naming the unit first.
    assert.equal((await run(ws, ['call', 'end_read_first', '-e', 'rf'])).code, 0);
    r = await run(ws, ['show', impl.record_id, '-e', 'rf', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json().display_receipt);
    r = await run(ws, ['records', '-e', 'rf', '--type', 'display_receipt', '--json']);
    const receipts = r.json().records;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].created_by.channel, 'auditor');
    assert.deepEqual(receipts[0].body.implemented_presented_for, [unit]);
    assert.deepEqual(receipts[0].body.rendered, [impl]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
