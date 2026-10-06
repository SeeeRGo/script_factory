// Match the complete INN: a ten-digit organization INN must not match part of a personal INN.
export function containsInn(text, inn) {
  return /^\d{10}(\d{2})?$/.test(inn || '')
    && new RegExp(`(^|[^0-9])${inn}([^0-9]|$)`).test(String(text || ''));
}

export function uniqueCertificateIndex(candidates, inn) {
  const matches = candidates.flatMap((candidate, index) => candidate.usable && containsInn(candidate.text, inn) ? [index] : []);
  if (matches.length !== 1) {
    const code = matches.length ? 'CERTIFICATE_AMBIGUOUS' : 'CERTIFICATE_NOT_FOUND';
    throw Object.assign(new Error(matches.length ? 'Несколько пригодных подписей с заданным ИНН' : 'Нет пригодной подписи с заданным ИНН'), { code });
  }
  return matches[0];
}

export async function selectSbisCertificate(page, { inn, selector, unusableSelector, signal }) {
  const rows = await page.$$(selector);
  try {
    const candidates = await Promise.all(rows.map(row => row.evaluate((element, excluded) => ({
      text: element.innerText,
      usable: element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden'
        && !element.closest(excluded)
        && !element.querySelector('[aria-disabled="true"], [disabled]'),
    }), unusableSelector || '.controls-SpoilerView, [aria-disabled="true"], [disabled]')));
    const index = uniqueCertificateIndex(candidates, inn);
    if (signal?.aborted) throw signal.reason;
    await rows[index].click();
    return { certificate_selected: true, certificate_inn: inn, eligible_certificate_count: candidates.filter(c => c.usable).length };
  } finally { await Promise.all(rows.map(row => row.dispose())); }
}
