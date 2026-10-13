import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers.ts';
import { acceptPolicy, display, head, LIMITS } from './decision-fixtures.ts';
import { runQueue } from '../src/runner/index.ts';
import type { Ref } from '../src/core/refs.ts';

// FR-35: leads per audit unit from declared generators, with coverage status, on a real build.

test('lead generators propose questions per unit and record which generators ran', { timeout: 180_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'leads';
    const target = join(h.dir, 'target');
    cpSync(join(import.meta.dirname, 'fixtures', 'vault'), target, { recursive: true });
    // An unguarded admin-style function without a modifier, and a failing project test.
    const src = readFileSync(join(target, 'src', 'Vault.sol'), 'utf8').replace(/\n}\s*$/, '\n\n    function sweep(address to) external {\n        balanceOf[to] = 0;\n        payable(to).transfer(address(this).balance);\n    }\n}\n');
    writeFileSync(join(target, 'src', 'Vault.sol'), src);
    writeFileSync(join(target, 'test', 'Broken.t.sol'), '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract BrokenTest { function test_known_broken() public pure { require(false, "documented as broken"); } }\n');
    h.auditor.do(eid, 'create_engagement', { name: 'Leads', owner: 'auditor', audit_purpose: 'lead generation' });
    acceptPolicy(h, eid);
    const reg = h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    const eng = head(h, eid, 'eng-0001');
    const intake = h.screen.do(eid, 'authorize_work', {
      reviewed: [eng],
      display_receipt: display(h, eid, [eng]),
      inputs: { kind: 'intake', capabilities: { tools: ['forge_build', 'forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'baseline',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;
    h.auditor.do(eid, 'request_job', { authorization: intake, ...reg.build_request, limits: { runtime_seconds: 120 } });
    h.auditor.do(eid, 'request_job', { authorization: intake, purpose: 'baseline_tests', adapter: 'forge_test', snapshot: reg.snapshot, args: {}, limits: { runtime_seconds: 120 } });
    await runQueue(h.controller, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw' }, { name: 'Vault.sweep' }] } }).audit_unit as Ref;

    const res = h.auditor.do(eid, 'generate_leads');
    const store = h.ws.store(eid, true);
    const leads = res.created.map((c: { investigation: Ref }) => store.get(c.investigation, 'investigation'));
    const byGen = (g: string) => leads.filter((l: { body: { lead_generator: string } }) => l.body.lead_generator === g);
    assert.ok(byGen('attack_vector_sweep').some((l: { body: { question: string } }) => /re-enter/.test(l.body.question) && /withdraw/.test(l.body.question)), 'reentrancy lead for withdraw');
    assert.ok(byGen('attack_vector_sweep').some((l: { body: { question: string } }) => /unprivileged caller/.test(l.body.question) && /sweep/.test(l.body.question)), 'access-control lead for sweep');
    assert.ok(byGen('project_test_suite').some((l: { body: { question: string } }) => /test_known_broken/.test(l.body.question)), 'failing project test becomes a lead');
    assert.ok(leads.every((l: { body: { work_state: string; origin: string } }) => l.body.work_state === 'proposed' && l.body.origin === 'agent'), 'leads are proposals');
    const withdrawLead = byGen('attack_vector_sweep').find((l: { body: { question: string } }) => /withdraw/.test(l.body.question));
    assert.deepEqual(withdrawLead.body.audit_units.map((u: Ref) => u.record_id), [unit.record_id], 'mapped to its unit');
    const cov = store.mustHead(unit.record_id, 'audit_unit').body.lead_generator_coverage;
    assert.ok(cov.some((c) => c.generator === 'attack_vector_sweep' && c.status === 'ran'));
    assert.ok(cov.some((c) => c.generator === 'mechanism_library'));
    // A rerun does not duplicate leads.
    assert.equal(h.auditor.do(eid, 'generate_leads').created.length, 0);
    // The batch proposal shows the coverage.
    const prep = h.auditor.do(eid, 'prepare_work', { kind: 'batch', investigations: [{ record_id: withdrawLead.record_id, revision: withdrawLead.revision }] });
    assert.ok(prep.gaps.every((g: string) => !/no lead generator has run/.test(g)));
  } finally {
    h.cleanup();
  }
});
