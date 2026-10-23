import fs from 'node:fs';
import { atomicWriteFileSync } from './coordination.js';

function parseRecords(content, filePath) {
  const records = [];
  let row = [];
  let field = '';
  let state = 'start';
  let touched = false;
  let recordNumber = 1;

  const fail = (reason) => {
    throw new Error(`Malformed CSV in ${filePath} at record ${recordNumber}: ${reason}`);
  };
  const finishField = () => {
    row.push(field);
    field = '';
    state = 'start';
  };
  const finishRecord = () => {
    const explicitQuotedEmptyField = state === 'after_quote' && row.length === 0 && field === '';
    finishField();
    if (!(row.length === 1 && row[0] === '' && field === '' && state === 'start' && !explicitQuotedEmptyField)) records.push(row);
    row = [];
    touched = false;
    recordNumber += 1;
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    touched = true;
    if (state === 'quoted') {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'after_quote';
        }
      } else if (char === '\r' || char === '\n') {
        // Newlines inside quoted fields are data. Preserve their original
        // bytes so a CSV read/write cycle does not rewrite CRLF or bare CR.
        field += char;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (state === 'after_quote' || state === 'start' || state === 'unquoted') {
        finishRecord();
        if (char === '\r' && content[index + 1] === '\n') index += 1;
        continue;
      }
    }
    if (state === 'start') {
      if (char === '"') state = 'quoted';
      else if (char === ',') finishField();
      else {
        field += char;
        state = 'unquoted';
      }
    } else if (state === 'unquoted') {
      if (char === ',') finishField();
      else if (char === '"') fail('quote inside an unquoted field');
      else field += char;
    } else if (state === 'after_quote') {
      if (char === ',') finishField();
      else fail('unexpected character after a quoted field');
    }
  }

  if (state === 'quoted') fail('unterminated quoted field');
  if (touched || row.length > 0 || field) finishRecord();
  return records;
}

function escapeValue(value) {
  const text = value == null ? '' : String(value);
  if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function readCsv(filePath, expectedHeaders = undefined) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const records = parseRecords(fs.readFileSync(filePath, 'utf8'), filePath);
  if (records.length === 0) return [];
  const headers = records[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error(`Malformed CSV in ${filePath}: header fields must be non-empty and unique`);
  }
  if (expectedHeaders && (headers.length !== expectedHeaders.length || headers.some((header, index) => header !== expectedHeaders[index]))) {
    throw new Error(`Malformed CSV in ${filePath}: headers do not match the expected schema`);
  }
  return records.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(`Malformed CSV in ${filePath} at record ${index + 2}: expected ${headers.length} fields, found ${values.length}`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

export function writeCsv(filePath, headers, rows) {
  const lines = [headers.map(escapeValue).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeValue(row[header] ?? '')).join(','));
  }
  atomicWriteFileSync(filePath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
}
