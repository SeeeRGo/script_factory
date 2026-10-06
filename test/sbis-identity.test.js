import test from 'node:test';
import assert from 'node:assert/strict';
import { containsInn, selectedFileIndex } from '../src/sbis-identity.js';

test('INN verification matches full identifiers, including leading zeros', () => {
  assert.equal(containsInn('ИНН: 0123456789, организация', '0123456789'), true);
  assert.equal(containsInn('ИНН 123456789012', '123456789012'), true);
  assert.equal(containsInn('ИНН 123456789012', '1234567890'), false);
  assert.equal(containsInn('ИНН 11234567890120', '123456789012'), false);
  assert.equal(containsInn('ИНН 123456789012', ''), false);
});

import { uniqueCertificateIndex } from '../src/sbis-identity.js';

test('certificate selection excludes unusable keys and refuses missing or ambiguous INNs', () => {
  const rows = [
    { text: 'ИНН 123456789012, истекла', usable: false },
    { text: 'ИНН 987654321098', usable: true },
    { text: 'ИНН 123456789012', usable: true },
  ];
  assert.equal(uniqueCertificateIndex(rows, '123456789012'), 2);
  assert.equal(uniqueCertificateIndex(rows, '987654321098'), 1);
  assert.throws(() => uniqueCertificateIndex(rows, '1234567890'), { code: 'CERTIFICATE_NOT_FOUND' });
  assert.throws(() => uniqueCertificateIndex(rows, '000000000000'), { code: 'CERTIFICATE_NOT_FOUND' });
  assert.throws(() => uniqueCertificateIndex([...rows, rows[2]], '123456789012'), { code: 'CERTIFICATE_AMBIGUOUS' });
});

test('file selection requires an exact name, unique visible row and matching full path', () => {
  const row = { name: 'NO_test.xml', path: 'C:\\Reports\\NO_test.xml', visible: true };
  assert.equal(selectedFileIndex([row], 'NO_test.xml', 'c:/reports/NO_test.xml'), 0);
  assert.equal(selectedFileIndex([{ ...row, path: 'file:///C:/Reports/NO_test.xml' }], 'NO_test.xml', row.path), 0);
  for (const rows of [[{ ...row, name: 'otherNO_test.xml' }], [{ ...row, visible: false }], [row, row], [{ ...row, path: 'C:/Other/NO_test.xml' }], [{ ...row, path: null }]]) {
    assert.throws(() => selectedFileIndex(rows, 'NO_test.xml', row.path), { code: 'FILE_SELECTION_MISMATCH' });
  }
});
