import { refKey, type Ref } from '../core/refs.ts';
import type { RecordEnvelope } from '../schema/records.ts';

// What the screen actually rendered, in order: the content of the display receipt
// (design/harness-glossary.md, "Display receipt"). A revision enters `rendered` only when its content
// was written to the terminal; a section enters `sections` when the auditor opened it, so the
// receipt records the real presentation order that the controller checks (DEC-008, Q-017).

export class DisplayLog {
  readonly started_at: string;
  private readonly clock: () => string;
  private readonly renderedRefs = new Map<string, Ref>();
  private readonly sectionList: { section: string; opened_at: string }[] = [];
  private readonly implementedUnits = new Map<string, Ref>();

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
    this.started_at = clock();
  }

  /** Note that a record revision's content was rendered. IMPLEMENTED content marks its units presented. */
  rendered(env: RecordEnvelope | Ref): void {
    const r: Ref = { record_id: env.record_id, revision: env.revision };
    this.renderedRefs.set(refKey(r), r);
    if ('body' in env) {
      for (const u of implementedUnitsOf(env)) this.implementedUnits.set(refKey(u), u);
    }
  }

  opened(section: string): void {
    this.sectionList.push({ section, opened_at: this.clock() });
  }

  hasOpened(section: string): boolean {
    return this.sectionList.some((s) => s.section === section);
  }

  get sections(): readonly { section: string; opened_at: string }[] {
    return this.sectionList;
  }

  get refs(): Ref[] {
    return [...this.renderedRefs.values()];
  }

  has(r: Ref): boolean {
    return this.renderedRefs.has(refKey(r));
  }

  /** Payload for the `record_display` operation. */
  toPayload(): {
    rendered: Ref[];
    sections: { section: string; opened_at: string }[];
    started_at: string;
    ended_at: string;
    implemented_presented_for: Ref[];
  } {
    return {
      rendered: this.refs,
      sections: [...this.sectionList],
      started_at: this.started_at,
      ended_at: this.clock(),
      implemented_presented_for: [...this.implementedUnits.values()],
    };
  }
}

/**
 * Audit units whose IMPLEMENTED behavior a record presents (glossary, "Intent timing"): implemented or
 * shared system statements, correspondences that map implemented statements, and KB diagrams of the
 * implemented model or of the comparison. Rendering them is the "first presentation" boundary the
 * controller derives intent timing from, and read-first mode withholds them.
 */
export function implementedUnitsOf(env: RecordEnvelope): Ref[] {
  if (env.type === 'system_statement') {
    const b = env.body as RecordEnvelope<'system_statement'>['body'];
    return b.affiliation === 'implemented' || b.affiliation === 'shared' ? b.audit_units : [];
  }
  if (env.type === 'behavioral_correspondence') {
    const b = env.body as RecordEnvelope<'behavioral_correspondence'>['body'];
    return b.implemented && b.implemented.length ? [b.audit_unit] : [];
  }
  if (env.type === 'kb_diagram') {
    const b = env.body as RecordEnvelope<'kb_diagram'>['body'];
    return b.affiliation === 'implemented' || b.affiliation === 'comparison' ? [b.audit_unit] : [];
  }
  return [];
}

/** True while read-first mode is active (DEC-009 Q-023): implemented behavior is withheld. */
export function readFirstActive(engagement: RecordEnvelope<'engagement'> | undefined): boolean {
  return !!engagement?.body.read_first && engagement.body.read_first.ended_at === null;
}

export const WITHHELD_NOTICE = 'withheld: read-first mode is active; IMPLEMENTED behavior is shown after `end_read_first`';
