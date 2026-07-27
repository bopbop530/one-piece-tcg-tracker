/* ============================================================================
   OPTCG QUANT — collection.js
   Collection data model, Google Sheets sync, and portfolio math.
   No DOM access in this file.
   ========================================================================== */

const OQ_COLLECTION = (function (D, E) {
  'use strict';

  /* ==========================================================================
     MODEL

     collections: [{ id, name, kind:'keep'|'trade', createdAt, updatedAt, deleted }]
     items:       [{ id, colId, key, qty, cond, grader, grade, paid, note,
                     updatedAt, deleted }]

     `key` is set_id|card_image_id|card_name — the ONLY identifier that is
     actually unique in this dataset. card_set_id has 723 collisions and
     card_image_id has 41, so anything shorter silently merges a $108 SP with
     a $20 parallel. See engine.js cardKey().

     A graded card carries `grader` + `grade`; `cond` applies to raw copies
     only. There is no free market feed for graded prices, so `paid` (and the
     manual value on a graded row) is whatever you enter.
     ========================================================================== */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * `tradePct` is what a vendor actually pays against market — nobody trades
   * at 1:1 at a show, so a trade binder valued at full market is a number you
   * can never realise. Defaults to 80% for trade stock, 100% for keeps.
   */
  function newCollection(name, kind) {
    const now = Date.now();
    return { id: uid(), name: name, kind: kind || 'keep',
             tradePct: kind === 'trade' ? 80 : 100,
             createdAt: now, updatedAt: now, deleted: 0 };
  }

  /** Older rows predate tradePct; keeps are always 1:1. */
  const rateOf = col =>
    !col ? 100 : (col.tradePct == null ? (col.kind === 'trade' ? 80 : 100) : Number(col.tradePct));

  /**
   * `value` and `paid` are deliberately separate.
   *   value — what the card is worth. Live market for raw copies; entered by
   *           hand for graded ones, because no free feed carries graded prices.
   *   paid  — what it cost you. Cost basis, never a valuation.
   * Collapsing them into one field makes every gain/loss figure meaningless.
   */
  function newItem(colId, key, patch) {
    return Object.assign({
      id: uid(), colId: colId, key: key,
      qty: 1, cond: 'NM', grader: '', grade: '',
      value: null, paid: null, note: '',
      src: 'pull',                 // 'pull' | 'buy' — drives the rip scoreboard
      updatedAt: Date.now(), deleted: 0
    }, patch || {});
  }

  const isGraded = it => !!(it.grader && it.grade !== '' && it.grade != null);

  /** A sealed-product purchase you opened. The cost side of the rip scoreboard. */
  function newOpen(setId, boxes, cost) {
    return { id: uid(), setId: setId, boxes: Number(boxes) || 1,
             cost: Number(cost) || 0, date: new Date().toISOString().slice(0, 10),
             updatedAt: Date.now(), deleted: 0 };
  }

  /**
   * Did ripping actually pay?
   *
   * Only counts cards you marked as pulled from packs. Singles you bought are
   * not winnings — including them would let a shopping spree masquerade as good
   * luck. Sets where you logged opens but no pulls are reported honestly rather
   * than scored, because "spent $600, pulled $0" almost always means you have
   * not finished logging.
   */
  function scoreboard(opens, items, priceFor, setName, isBooster) {
    const bySet = {};
    const touch = id => (bySet[id] = bySet[id] || {
      setId: id, name: setName ? setName(id) : id,
      boxes: 0, spent: 0, pulledValue: 0, pulledCards: 0
    });

    for (const o of live(opens)) {
      const r = touch(o.setId);
      r.boxes += Number(o.boxes) || 0;
      r.spent += Number(o.cost) || 0;
    }
    for (const it of live(items)) {
      if (it.src !== 'pull') continue;
      const setId = it.key.split('|')[0];
      // Belt and braces against a card marked "pulled" that could never have
      // come from a pack — a promo or starter-deck row would otherwise invent
      // a phantom set with winnings and no spend, inflating the return.
      if (isBooster && !isBooster(setId)) continue;
      const r = touch(setId);
      const qty = Number(it.qty) || 0;
      const w = isGraded(it)
        ? ((it.value != null && it.value !== '') ? Number(it.value) : null)
        : ((it.value != null && it.value !== '') ? Number(it.value) : priceFor(it.key));
      r.pulledCards += qty;
      if (w != null) r.pulledValue += w * qty;
    }

    const rows = Object.keys(bySet).map(k => {
      const r = bySet[k];
      r.net = r.pulledValue - r.spent;
      r.ret = r.spent > 0 ? r.pulledValue / r.spent - 1 : null;
      // Spent money but logged nothing: incomplete, not a loss.
      r.incomplete = r.spent > 0 && r.pulledCards === 0;
      return r;
    }).sort((a, b) => b.spent - a.spent);

    const tot = rows.reduce((a, r) => ({
      boxes: a.boxes + r.boxes, spent: a.spent + r.spent,
      pulledValue: a.pulledValue + r.pulledValue, pulledCards: a.pulledCards + r.pulledCards
    }), { boxes: 0, spent: 0, pulledValue: 0, pulledCards: 0 });
    tot.net = tot.pulledValue - tot.spent;
    tot.ret = tot.spent > 0 ? tot.pulledValue / tot.spent - 1 : null;

    return { rows, total: tot };
  }

  /* ==========================================================================
     MERGE — per-row last-write-wins.

     Storing one row per card (rather than a JSON blob in a single cell) is what
     makes real multi-device sync possible: two devices editing DIFFERENT cards
     both survive, because the merge is per row instead of per document. A blob
     would mean whoever saves second erases the other's work.

     Deletes are tombstones (deleted=1 + updatedAt). Dropping a row outright
     would let it resurrect from whichever device had not synced yet.
     ========================================================================== */
  function mergeRows(local, remote) {
    const byId = {};
    for (const row of local)  byId[row.id] = row;
    for (const row of remote) {
      const mine = byId[row.id];
      if (!mine || (row.updatedAt || 0) > (mine.updatedAt || 0)) byId[row.id] = row;
    }
    return Object.keys(byId).map(k => byId[k]);
  }

  /** Tombstones are kept for sync correctness but never shown. */
  const live = rows => rows.filter(r => !r.deleted);

  /* ==========================================================================
     PORTFOLIO
     ========================================================================== */

  /**
   * Value a collection at current market.
   * Graded copies have no market feed, so they fall back to what you paid —
   * and are counted separately so a big graded holding cannot quietly inflate
   * a number that is otherwise live.
   */
  function valueOf(items, priceFor) {
    let raw = 0, graded = 0, cards = 0, unpriced = 0, cost = 0;
    // Gain is only meaningful against cards you actually recorded a cost for.
    // Comparing the whole portfolio to a partial cost basis invents profit.
    let costedValue = 0, costedCards = 0;

    for (const it of live(items)) {
      const qty = Number(it.qty) || 0;
      cards += qty;
      const hasCost = it.paid != null && it.paid !== '';
      if (hasCost) {
        cost += Number(it.paid) * qty;
        costedCards += qty;
        const w = isGraded(it)
          ? ((it.value != null && it.value !== '') ? Number(it.value) : null)
          : ((it.value != null && it.value !== '') ? Number(it.value) : priceFor(it.key));
        if (w != null) costedValue += w * qty;
      }

      if (isGraded(it)) {
        // No market feed for graded — worth only what you say it is worth.
        if (it.value != null && it.value !== '') graded += Number(it.value) * qty;
        else unpriced += qty;
      } else {
        // A manual value overrides the feed; otherwise live market.
        const p = (it.value != null && it.value !== '') ? Number(it.value) : priceFor(it.key);
        if (p == null) unpriced += qty;
        else raw += p * qty;
      }
    }
    return {
      raw, graded, total: raw + graded, cards, unpriced, cost,
      costedCards, costedValue,
      gain: costedValue - cost,
      gainPct: cost > 0 ? (costedValue - cost) / cost : null,
      // True only when every card has a recorded cost — otherwise the gain
      // covers a subset and the UI has to say so.
      costComplete: costedCards === cards
    };
  }

  /** Roll up duplicates so the UI shows one line per distinct card+state. */
  function group(items) {
    const out = {};
    for (const it of live(items)) {
      const gk = [it.key, it.cond, it.grader, it.grade].join('~');
      if (!out[gk]) out[gk] = { key: it.key, cond: it.cond, grader: it.grader,
                                grade: it.grade, qty: 0, rows: [] };
      out[gk].qty += Number(it.qty) || 0;
      out[gk].rows.push(it);
    }
    return Object.keys(out).map(k => out[k]);
  }

  /* ==========================================================================
     SHEETS TRANSPORT

     The Apps Script /exec URL is a bearer key: anyone holding it can read and
     write the sheet. The repo is public, so it is never baked into source —
     it is pasted once per device and kept in localStorage. If it ever leaks,
     redeploy for a fresh URL.

     POST uses text/plain deliberately. An application/json body triggers a
     CORS preflight, and Apps Script does not answer OPTIONS.
     ========================================================================== */

  function validUrl(url) {
    return typeof url === 'string' && /^https:\/\/script\.google\.com\//.test(url);
  }

  async function pull(url) {
    if (!validUrl(url)) throw new Error('Not a Google Apps Script URL');
    const res = await fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 'action=pull');
    if (!res.ok) throw new Error('Sheet returned HTTP ' + res.status);
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error((data && data.error) || 'Sheet rejected the read');
    return { collections: data.collections || [], items: data.items || [], opens: data.opens || [] };
  }

  async function push(url, payload) {
    if (!validUrl(url)) throw new Error('Not a Google Apps Script URL');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids preflight
      body: JSON.stringify(Object.assign({ action: 'push' }, payload))
    });
    if (!res.ok) throw new Error('Sheet returned HTTP ' + res.status);
    const data = await res.json();
    // Validate the body, not just the status — Apps Script happily returns 200
    // with an HTML error page, which is how you get a false success tick.
    if (!data || data.ok !== true) throw new Error((data && data.error) || 'Sheet rejected the write');
    return data;
  }

  return {
    uid, newCollection, newItem, newOpen, isGraded, rateOf,
    mergeRows, live, valueOf, group, scoreboard,
    validUrl, pull, push
  };
})(OQ_DATA, OQ_ENGINE);
