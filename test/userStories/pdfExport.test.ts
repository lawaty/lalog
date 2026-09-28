import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setupExtension, flush, waitFor } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { PdfDoc } from '../../src/reporting/pdf';
import {
  buildPdfModel,
  renderPdfReport,
  defaultPdfOptions,
  resolvePdfOptions,
  pdfPresets,
} from '../../src/reporting/pdfReport';
import type { Session } from '../../src/core/types';

const MIN = 60 * 1000;
const H = 60 * MIN;

function sessionAt(startedAt: number, activeMinutes: number, extra: Partial<Session> = {}): Session {
  return {
    id: 's' + startedAt,
    workspaceKey: 'ws1',
    workspaceName: 'ws1name',
    startedAt,
    endedAt: startedAt + activeMinutes,
    lastActivityAt: startedAt + activeMinutes,
    activeMinutes,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [{ start: startedAt, end: startedAt + activeMinutes }],
    activityTs: [],
    ...extra,
  };
}

test('US-6.6 · PDF writer emits a deterministic, well-formed PDF 1.4 document', () => {
  const make = () => {
    const doc = new PdfDoc();
    doc.text('Hello (world) \\ back', { x: 48 });
    doc.text('café', { x: 48, font: 'Helvetica-Bold', color: [0.1, 0.1, 0.1] });
    for (let i = 0; i < 120; i++) doc.text('filler line ' + i, { x: 48 });
    return doc;
  };
  const doc = make();
  const buf1 = doc.save();
  const buf2 = make().save();
  assert.deepEqual(buf1, buf2, 'same input renders identical bytes');

  const str = buf1.toString('latin1');
  assert.ok(str.startsWith('%PDF-1.4'));
  assert.ok(doc.pageCount >= 2, 'auto page break');
  assert.ok(str.includes('/Count ' + doc.pageCount));
  assert.ok(str.includes('Hello \\(world\\) \\\\ back'), '( ) and \\ escaped');
  assert.ok(str.includes('caf\xe9'), 'latin-1 accent byte');

  const m = str.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(m, 'startxref present');
  assert.equal(str.slice(Number(m![1]), Number(m![1]) + 4), 'xref', 'startxref points at xref');

  const w = new PdfDoc();
  assert.deepEqual(w.wrapText('one two three', w.measure('one two', 10), 10), ['one two', 'three']);
});

test('US-6.6 · PDF page tree and xref offsets are structurally valid', () => {
  const doc = new PdfDoc();
  doc.text('page one', { x: 48 });
  for (let i = 0; i < 200; i++) doc.text('overflow ' + i, { x: 48 });
  const str = doc.save().toString('latin1');
  const n = doc.pageCount;
  assert.ok(n >= 3, 'multi-page fixture');

  // Every /Kids entry must be a full indirect reference — a bare "6 8" makes the
  // page tree unreadable and viewers silently render nothing.
  const kids = str.match(/\/Kids \[([^\]]*)\]/);
  assert.ok(kids, 'Pages object has a /Kids array');
  const refs = kids![1].match(/\d+ 0 R/g) ?? [];
  assert.equal(refs.length, n, 'one /Kids entry per page');
  assert.equal(
    kids![1].replace(/\s+/g, ' ').trim(),
    refs.join(' '),
    '/Kids holds nothing but indirect references'
  );
  for (const ref of refs) {
    assert.match(ref, /^\d+ 0 R$/, `/Kids entry is an indirect reference: ${ref}`);
    const id = Number(ref.split(' ')[0]);
    const body = str.match(new RegExp(`\\n${id} 0 obj\\n([\\s\\S]*?)\\nendobj`));
    assert.ok(body, `object ${id} exists`);
    assert.ok(body![1].includes('/Type /Page'), `object ${id} is a page`);
    const contents = body![1].match(/\/Contents (\d+) 0 R/);
    assert.ok(contents, `page ${id} references a content stream`);
    assert.match(str, new RegExp(`\\n${contents![1]} 0 obj\\n<< \\/Length \\d+ >>\\nstream`), 'stream is a dict + stream');
  }

  // xref: every entry must be 20 bytes and land exactly on its object header.
  const start = Number(str.match(/startxref\n(\d+)\n%%EOF/)![1]);
  assert.equal(str.slice(start, start + 4), 'xref');
  const table = str.slice(start).match(/xref\n0 (\d+)\n/);
  assert.ok(table);
  const total = Number(table![1]);
  let cursor = start + table![0].length;
  assert.equal(str.slice(cursor, cursor + 20), '0000000000 65535 f \n', 'free entry is 20 bytes');
  cursor += 20;
  for (let id = 1; id < total; id++) {
    const entry = str.slice(cursor, cursor + 20);
    cursor += 20;
    assert.equal(entry.length, 20, `xref entry ${id} is 20 bytes`);
    assert.match(entry, /^\d{10} \d{5} n \n$/, `xref entry ${id} is well formed`);
    const at = Number(entry.slice(0, 10));
    assert.equal(str.slice(at, at + `${id} 0 obj`.length), `${id} 0 obj`, `xref entry ${id} offset`);
  }
  assert.equal(cursor, str.indexOf('trailer'), 'xref ends where the trailer begins');
});

test('US-6.6 · buildPdfModel buckets days and scopes like the report', () => {
  const now = Date.parse('2026-09-23T12:00:00');
  const d1 = Date.parse('2026-09-21T10:00:00');
  const d2 = Date.parse('2026-09-22T09:00:00');
  const d2b = Date.parse('2026-09-22T14:00:00');
  const model = buildPdfModel(
    [
      sessionAt(d1, 45 * MIN, { description: 'a' }),
      sessionAt(d2, 30 * MIN),
      sessionAt(d2b, 90 * MIN),
    ],
    [],
    'week',
    {},
    now,
    15 * MIN
  );
  assert.equal(model.days.length, 2);
  assert.equal(model.days[0].day, '2026-09-21');
  assert.equal(model.days[1].day, '2026-09-22');
  assert.equal(model.days[1].sessions.length, 2);
  assert.equal(model.totalMs, 165 * MIN);
  assert.equal(model.sessionCount, 3);
  assert.equal(model.scopeLabel, 'All sessions');

  const proj = { id: 'p1', name: 'Client A', color: '#409cd4', workspaceKeys: ['ws1'], pathHints: [], createdAt: 0 };
  const scoped = buildPdfModel(
    [sessionAt(d1, 45 * MIN, { description: 'a', projectId: 'p1' }), sessionAt(d2, 30 * MIN, { workspaceKey: 'ws2' })],
    [proj],
    'week',
    { projectId: 'p1' },
    now,
    15 * MIN
  );
  assert.equal(scoped.sessionCount, 1);
  assert.equal(scoped.totalMs, 45 * MIN);
  assert.equal(scoped.scopeLabel, 'Client A');

  const live = buildPdfModel(
    [sessionAt(d2, 10 * MIN, { endedAt: undefined, lastActivityAt: d2 + 10 * MIN })],
    [],
    'week',
    {},
    now,
    15 * MIN
  );
  assert.equal(live.sessionCount, 1, 'live session counted');
  assert.ok(live.totalMs <= 10 * MIN + 15 * MIN, 'live tail capped at the idle gap');
});

test('US-6.6 · exportPdf command writes a personal PDF with toggles and opens it', async (t) => {
  const ext = await setupExtension(t);
  mockVscode.queueInputBox('pdf desc');
  mockVscode.queueQuickPick('feature');
  await mockVscode.commands.executeCommand('lalog.describeNow');
  await flush();
  mockVscode.fireEdit('/ws/src/a.ts');
  t.mock.timers.tick(2000);
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();

  mockVscode.queueQuickPick('today');
  mockVscode.queueQuickPick('');
  mockVscode.queueQuickPick('personal');
  mockVscode.queueQuickPickMany([
    'includeDescriptions',
    'includeTimeRanges',
    'includeDayTotals',
    'includeSummaryTotals',
  ]);
  await mockVscode.commands.executeCommand('lalog.exportPdf');
  await waitFor(() => fs.readdirSync(ext.paths.reportsDir).some((f) => f.endsWith('.pdf')));

  const files = fs.readdirSync(ext.paths.reportsDir).filter((f) => f.endsWith('.pdf'));
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith('2026-09-21-today'), 'date-range prefixed filename');

  const str = fs.readFileSync(path.join(ext.paths.reportsDir, files[0]), 'latin1');
  assert.ok(str.startsWith('%PDF-1.4'));
  assert.ok(str.includes('pdf desc'), 'descriptions toggled on');
  assert.ok(/\d\d:\d\d-\d\d:\d\d/.test(str), 'time ranges toggled on');
  assert.ok(!str.includes('feature'), 'task types toggled off override the personal default');

  const multi = mockVscode._promptCalls.find((c) => c.title === 'Include in PDF');
  assert.ok(multi && multi.canPickMany, 'detail picker is a multi-select');

  const opened = mockVscode._openExternalCalls;
  assert.equal(opened.length, 1);
  assert.equal(opened[0].fsPath, path.join(ext.paths.reportsDir, files[0]));
  assert.ok(mockVscode._infoMessages.some((m) => m.includes('PDF exported')));

  mockVscode.queueQuickPick('today');
  mockVscode.queueQuickPick('');
  mockVscode.queueQuickPick('personal');
  mockVscode.queueQuickPickMany(['includeSummaryTotals']);
  await mockVscode.commands.executeCommand('lalog.exportPdf');
  await waitFor(() => fs.readdirSync(ext.paths.reportsDir).filter((f) => f.endsWith('.pdf')).length === 2);
  const second = fs.readdirSync(ext.paths.reportsDir).filter((f) => f.endsWith('.pdf'));
  assert.ok(second.some((f) => f.endsWith('-2.pdf')), 'existing report is not overwritten');
});

test('US-6.7 · client preset renders a minimal per-day abstract sheet', () => {
  const now = Date.parse('2026-09-23T12:00:00');
  const s1 = sessionAt(Date.parse('2026-09-21T10:00:00'), 45 * MIN, {
    description: 'Client work',
    type: 'feature',
    gitBranch: 'fix/pdf-branch',
    events: {
      edits: 8,
      saves: 1,
      terminal: 0,
      fileops: 0,
      tasks: 0,
      debug: 0,
      topFiles: [{ path: '/ws/auth.ts', edits: 8, firstTouch: 0, lastTouch: 0 }],
    },
  });
  const s2 = sessionAt(Date.parse('2026-09-22T09:00:00'), 90 * MIN);
  const model = buildPdfModel([s1, s2], [], 'week', {}, now, 15 * MIN);
  const str = renderPdfReport(model, defaultPdfOptions('client')).toString('latin1');

  assert.ok(str.includes('2026-09-21') && str.includes('2026-09-22'), 'day headings');
  assert.ok(str.includes('45m') && str.includes('1h 30m'), 'durations always render');
  assert.ok(str.includes('Client work'), 'descriptions');
  assert.ok(!str.includes('auth.ts'), 'top files excluded');
  assert.ok(!str.includes('fix/pdf-branch'), 'git excluded');
  assert.ok(!str.includes('feature'), 'task types excluded');
  assert.ok(str.includes('/Count 2'), 'client preset starts each day on a new page');

  const personal = renderPdfReport(model, defaultPdfOptions('personal')).toString('latin1');
  assert.ok(personal.includes('auth.ts'), 'personal shows top files');
  assert.ok(personal.includes('fix/pdf-branch'), 'personal shows git');
  assert.ok(personal.includes('/Count 1'), 'grouped days flow on one page');
});

test('US-6.7 · presets and resolvePdfOptions overlay toggles', () => {
  const presets = pdfPresets();
  assert.equal(presets.personal.includeTopFiles, true);
  assert.equal(presets.client.includeTopFiles, false);
  assert.equal(presets.client.includeDescriptions, true);
  assert.equal(presets.client.dayMode, 'separate');
  assert.equal(presets.personal.dayMode, 'grouped');

  const o = resolvePdfOptions('personal', { includeGit: false, dayMode: 'separate' });
  assert.equal(o.preset, 'personal');
  assert.equal(o.includeGit, false);
  assert.equal(o.includeDescriptions, true, 'untouched default kept');
  assert.equal(o.dayMode, 'separate');
});

test('US-6.6 · exportPdf cancel and empty toggle selection are handled', async (t) => {
  const ext = await setupExtension(t);
  mockVscode.fireEdit('/ws/src/a.ts');
  t.mock.timers.tick(2000);
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();

  mockVscode.queueQuickPick(undefined);
  await mockVscode.commands.executeCommand('lalog.exportPdf');
  await flush();
  assert.ok(
    !fs.readdirSync(ext.paths.reportsDir).some((f) => f.endsWith('.pdf')),
    'cancelling writes nothing'
  );

  mockVscode.queueQuickPick('today');
  mockVscode.queueQuickPick('');
  mockVscode.queueQuickPick('client');
  mockVscode.queueQuickPickMany([]);
  await mockVscode.commands.executeCommand('lalog.exportPdf');
  await waitFor(() => fs.readdirSync(ext.paths.reportsDir).some((f) => f.endsWith('.pdf')));
  const files = fs.readdirSync(ext.paths.reportsDir).filter((f) => f.endsWith('.pdf'));
  assert.equal(files.length, 1);
  const str = fs.readFileSync(path.join(ext.paths.reportsDir, files[0]), 'latin1');
  assert.ok(str.startsWith('%PDF-1.4'), 'empty selection still renders a document');
  assert.ok(str.includes('2026-09-21'), 'structural day headings still render');
});
