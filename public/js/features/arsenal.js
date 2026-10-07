/**
 * features/arsenal.js — "How he handles each pitch": whiff rate by family and type.
 */

'use strict';

/**
 * Builds the arsenal table: how the batter handles each pitch type, pooled across
 * all zones.
 *
 * This is the breakdown behind the family labels on the zone graphic. It lives at
 * the batter level rather than per-bucket because that is the only level the data
 * supports — pooled over zones a type carries ~92 swings (+/-9 points, p<0.001);
 * inside one bucket it carries ~6-10 (+/-28 to +/-37, indistinguishable from
 * noise). So the zone graphic answers "where", this answers "what", and neither
 * claims to answer both.
 *
 * Rows under computeArsenal's swing minimum show their counts but no rate.
 * Rendered as real elements (not a hover surface) so it prints — the dugout copy
 * is paper, where there is no hover.
 */
function createArsenal(batterData) {
  const { families, totalSwings, minSwings } = computeArsenal(batterData);
  if (!families.length || totalSwings === 0) return null;

  const pct = (r) => `${(r * 100).toFixed(0)}%`;
  const rateCells = (e) => e.whiffRate === null
    ? [createElement('td', { className: 'arsenal__rate arsenal__rate--thin' }, '—'),
       createElement('td', { className: 'arsenal__ci' }, `${e.swings} sw`)]
    : [createElement('td', { className: 'arsenal__rate' }, pct(e.whiffRate)),
       createElement('td', { className: 'arsenal__ci' }, `±${(e.ci * 100).toFixed(0)} · ${e.swings} sw`)];

  const rows = [];
  families.forEach(f => {
    rows.push(createElement('tr', { className: 'arsenal__family-row' },
      createElement('td', { className: 'arsenal__family' }, f.label),
      ...rateCells(f)
    ));
    // Only worth listing members when the family is actually a mix.
    if (f.types.length > 1) {
      f.types.forEach(e => rows.push(createElement('tr', { className: 'arsenal__type-row' },
        createElement('td', { className: 'arsenal__type' }, e.pitch),
        ...rateCells(e)
      )));
    }
  });

  return createElement('div', { className: 'arsenal' },
    createElement('div', { className: 'arsenal__title' }, 'How he handles each pitch'),
    createElement('table', { className: 'arsenal__table' }, createElement('tbody', {}, ...rows)),
    createElement('div', { className: 'arsenal__foot' },
      `whiff per swing · all zones · rate hidden under ${minSwings} swings`)
  );
}
