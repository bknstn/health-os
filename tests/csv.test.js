import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCsv, writeCsv } from '../src/csv.js';

test('CSV roundtrip preserves LF, CRLF, bare CR, commas, and quotes inside quoted fields', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-csv-roundtrip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rows.csv');
  const rows = [
    { id: 'lf', notes: 'first line\nsecond line' },
    { id: 'crlf', notes: 'first line\r\nsecond line' },
    { id: 'cr', notes: 'first line\rsecond line' },
    { id: 'quoted', notes: 'comma, then "quoted" text' }
  ];

  writeCsv(file, ['id', 'notes'], rows);

  assert.deepEqual(readCsv(file, ['id', 'notes']), rows);
});

test('CSV reader preserves an explicitly quoted empty single-field record', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-os-csv-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rows.csv');
  fs.writeFileSync(file, 'value\n""\n', 'utf8');

  assert.deepEqual(readCsv(file), [{ value: '' }]);
});
