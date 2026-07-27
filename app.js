/* ============================================================================
   OPTCG QUANT — app.js
   State, persistence, rendering.
   ========================================================================== */

(function (D, E, C) {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const KEY = {
    cards:  'oq.cards.v1',
    boxes:  'oq.boxes.v1',
    rates:  'oq.rates.v1',
    setRates: 'oq.setrates.v1',
    prefs:  'oq.prefs.v1',
    cols:   'oq.collections.v1',
    items:  'oq.items.v1',
    opens:  'oq.opens.v1',
    sync:   'oq.syncurl.v1',
    lastPush: 'oq.lastpush.v1',
    hist:   'oq.hist.v1'
  };

  /* ------------------------------------------------------------- storage -- */
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  /**
   * Returns false when the write did not happen.
   *
   * This used to swallow failures silently, which is fine for the card cache
   * (it just refetches) and NOT fine for the collection — a full localStorage
   * would drop your binder on the next reload with no warning at all. Callers
   * that hold user-entered data must check the result. saveCritical() does.
   */
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  let quotaWarned = false;
  /** For data the user typed and cannot recreate. Fails loudly, once. */
  function saveCritical(key, value) {
    if (save(key, value)) return true;

    // Most likely cause is the ~1.3MB card cache crowding a 5MB budget.
    // Dropping it is safe — it refetches — and usually frees enough room.
    try { localStorage.removeItem(KEY.cards); } catch (_) {}
    if (save(key, value)) return true;

    if (!quotaWarned) {
      quotaWarned = true;
      setSync('err', 'browser storage full');
      alert('Your browser storage is full, so this change could not be saved locally.\n\n' +
            'Connect Google Sheets on the My Collection tab to keep your data safe, ' +
            'or free up space for this site.');
    }
    return false;
  }

  /* --------------------------------------------------------------- state -- */
  const S = {
    cards: [],
    bySet: {},
    byKey: {},                       // cardKey -> card, for collection lookups
    tab: 'rip',
    boxes:  load(KEY.boxes, {}),     // setId -> user box price (Set Explorer only)
    rates:    load(KEY.rates, {}),     // profile -> { perBox, packsPerBox }
    setRates: load(KEY.setRates, {}),  // setId   -> { perBox, packsPerBox }
    prefs:  load(KEY.prefs, { friction: 100, advanced: false }),
    ripSet: null, ripCard: null, ripSearch: '', ripRarity: 'all', ripColor: 'all',
    rateScope: null,                 // which scope the pull-rate editor is on
    sigAutoScanned: false,
    scanning: false, scanAbort: false,
    fetchedAt: null,
    indexCache: {},
    sort: { sets: { by: 'roi', dir: -1 }, sig: { by: 'rank', dir: -1 } },

    // ---- collection
    cols:    load(KEY.cols, []),
    items:   load(KEY.items, []),
    opens:   load(KEY.opens, []),
    curCol:  null,
    addSet:  null,
    addSearch: '',
    browseSets: null,
    syncUrl: load(KEY.sync, ''),
    lastPushAt: load(KEY.lastPush, 0),
    syncState: 'off',                // off | ok | busy | err
    syncMsg: '',
    pushTimer: null
  };

  /* ------------------------------------------------------------- helpers -- */
  const setMeta   = id => D.SETS.find(s => s.id === id) ||
                          (S.browseSets || []).find(s => s.id === id);
  const setName   = id => { const m = setMeta(id); return m ? m.name : id; };
  const setShort  = id => { const m = setMeta(id); return m ? m.short : id; };
  const profileOf = id => { const m = setMeta(id); return (m && m.profile) || 'STANDARD'; };

  /**
   * Effective pull-rate config for a set.
   *
   * Three layers, most specific wins:
   *   profile default -> your profile override -> your per-set override
   *
   * Per-set matters because sets genuinely differ: OP-01 to OP-03 have no SP
   * cards at all, OP-13 swapped Manga Rares for Super Alt Arts, and OP-14/15
   * are simply bigger sets. Pool SIZE is already per-set everywhere in the app
   * (a card's odds are rate ÷ pool ÷ packs), so a set with 5 Manga Rares
   * correctly gives each one a fifth of the odds. What this adds is per-set
   * control of the RATE itself.
   */
  function configFor(setId) {
    const prof  = profileOf(setId);
    const base  = D.PROFILES[prof];
    const pOver = S.rates[prof] || {};
    const sOver = S.setRates[setId] || {};
    return {
      profile: prof,
      label: base.label,
      verified: base.verified !== false,
      customised: !!S.setRates[setId],
      packsPerBox: sOver.packsPerBox != null ? sOver.packsPerBox
                 : pOver.packsPerBox != null ? pOver.packsPerBox
                 : base.packsPerBox,
      cardsPerPack: base.cardsPerPack,
      perBox: Object.assign({}, base.perBox, pOver.perBox || {}, sOver.perBox || {})
    };
  }

  function boxPrice(setId) {
    if (S.boxes[setId] != null) return S.boxes[setId];
    const m = setMeta(setId);
    return m ? m.box : 0;
  }
  const boxIsEstimate = setId => S.boxes[setId] == null;

  const priceOf = card => card.market_price || 0;

  /** Live market price for a collection row, via its stored composite key. */
  function priceForKey(key) {
    const c = S.byKey[key];
    return c ? (c.market_price || 0) : null;
  }

  function indexFor(setId) {
    if (S.indexCache[setId]) return S.indexCache[setId];
    const idx = E.buildSetIndex(setId, S.bySet[setId] || [], priceOf);
    S.indexCache[setId] = idx;
    return idx;
  }
  const invalidate = () => { S.indexCache = {}; };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Size a card grid to show whole rows only.
   *
   * Tile height depends on column width (the art is aspect-ratio locked), so a
   * hard-coded max-height cannot stay right — 460px happened to slice the third
   * row in half. Measure a real tile and snap the container to N rows.
   */
  function fitGridRows(sel, rows) {
    const apply = () => {
      const grid = $(sel);
      if (!grid) return;
      const tile = grid.querySelector('.pick');
      if (!tile) { grid.style.maxHeight = ''; return; }
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
      const h = tile.getBoundingClientRect().height;
      if (!h) return;
      // Exactly N rows: no slack, or the next row peeks through and it reads
      // as a cut-off row rather than a scrollable list.
      grid.style.maxHeight = Math.round(rows * h + (rows - 1) * gap) + 'px';
      grid.classList.add('rows-set');
    };

    // Measure twice: once now, once after layout settles. The first pass runs
    // before the card images have sized, which reported tiles 10px taller and
    // left 2.1 rows showing instead of 2.
    apply();
    requestAnimationFrame(apply);
    const img = $(sel + ' .pick img');
    if (img && !img.complete) img.addEventListener('load', apply, { once: true });
  }

  /* Column count changes with width, which changes tile height. */
  let refitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      fitGridRows('#rip-grid', 2);
      fitGridRows('#add-grid', 3);
    }, 150);
  });

  /**
   * Card art, or a labelled placeholder when the source has none.
   * A handful of DON!! records come back with a null image; an <img> with an
   * empty src renders as an invisible gap that just looks like a bug.
   */
  function cardArt(card, extraClass) {
    const cls = extraClass ? ' ' + extraClass : '';
    if (!card.card_image) {
      return `<div class="noart${cls}" title="${esc(card.card_name)}">
        <span>no image</span></div>`;
    }
    return `<img class="${esc((extraClass || '').trim())}" src="${esc(card.card_image)}"
      alt="${esc(card.card_name)}" loading="lazy"
      onerror="this.outerHTML='&lt;div class=\\'noart${cls}\\'&gt;&lt;span&gt;no image&lt;/span&gt;&lt;/div&gt;'">`;
  }

  /** Rarity chip for a card thumbnail, sitting where the real card prints it. */
  function rarityChip(card) {
    const b = E.rarityBadge(card);
    return `<span class="rchip r-${esc(b.tone)}" title="${esc(b.label)}">` +
           `${b.star ? '<span class="star">★</span>' : ''}${esc(b.text)}</span>`;
  }

  /* ============================================================== DATA ==== */

  /**
   * DON!! cards come back in a different shape: no set_id, no card_set_id, and
   * the set only appears as a trailing code inside optcg_don_name, e.g.
   * "DON!! Card (Egghead) - The Azure Sea's Seven (OP14)".
   *
   * Reshaped here into the same record every other part of the app expects, so
   * nothing downstream needs to know DON!! cards are special.
   */
  function normaliseDons(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];

    // Fallback lookup by set NAME. The OP-16 alt-art DON!! is labelled
    // "DON!! Card (Alternate Art) - The Time of Battle" with no trailing code
    // at all, so code matching alone loses it entirely.
    const byName = {};
    for (const s of D.SETS) byName[s.name.toLowerCase()] = s.id;

    for (const d of rows) {
      const label = d.optcg_don_name || d.card_name || '';
      // Trailing "(CODE)" is the product it belongs to.
      const m = label.match(/\(([A-Z]{2,4}-?[A-Z0-9]{0,2})\)\s*$/);
      const code = m ? m[1] : null;
      let setId = code ? D.DON_SET_CODES[code] : null;

      if (!setId) {
        // " - <Set Name>" tail, with any trailing code stripped off.
        const tail = label.replace(/\s*\([^()]*\)\s*$/, '').split(' - ').pop();
        if (tail) setId = byName[tail.trim().toLowerCase()] || null;
      }

      // Which non-booster product is it from, if any?
      const product = D.DON_NON_BOOSTER.find(p => label.indexOf(p) > -1) || null;
      const booster = !!setId && !product;

      out.push({
        card_set_id: 'DON',
        card_image_id: d.card_image_id,
        card_name: d.card_name,
        // Unmapped DONs (promos, starter decks) are parked under their code so
        // they stay searchable instead of vanishing.
        set_id: setId || ('DON-' + (code || 'OTHER')),
        set_name: label,
        rarity: 'DON',
        market_price: d.market_price,
        inventory_price: d.inventory_price,
        card_color: '', card_type: 'DON!!',
        // 4 DON!! records ship with a null image upstream (incl. the OP-16
        // Gold alt-art). Normalised to '' so rendering can show a placeholder
        // rather than a blank hole.
        card_image: d.card_image || '',
        date_scraped: d.date_scraped,
        donBooster: booster,
        donProduct: product || (setId ? null : 'Promo or starter deck DON!!'),
        donVariant: /\(Gold\)/.test(d.card_name) ? 'Gold DON!!'
                  : /\(Silver\)/.test(d.card_name) ? 'Silver DON!!'
                  : /Manga/.test(d.card_name) ? 'Manga DON!!'
                  : /Alternate Art/.test(d.card_name) ? 'Alt Art DON!!' : 'DON!!'
      });
    }
    return out;
  }

  async function fetchCards(force) {
    if (!force) {
      const cached = load(KEY.cards, null);
      if (cached && cached.rows && cached.rows.length) {
        applyCards(cached.rows, cached.at);
        return { fromCache: true };
      }
    }
    // Four separate catalogues. Only the first is required; the rest degrade
    // to "those cards are missing" rather than breaking the app.
    const [res, donRes, deckRes, promoRes] = await Promise.all([
      fetch(D.API.allCards, { cache: 'no-store' }),
      fetch(D.API.allDon, { cache: 'no-store' }).catch(() => null),
      fetch(D.API.allDecks, { cache: 'no-store' }).catch(() => null),
      fetch(D.API.allPromos, { cache: 'no-store' }).catch(() => null)
    ]);
    if (!res.ok) throw new Error('API returned HTTP ' + res.status);
    let rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('API returned no cards');

    if (donRes && donRes.ok) {
      try { rows = rows.concat(normaliseDons(await donRes.json())); } catch (_) {}
    }
    if (deckRes && deckRes.ok) {
      // Starter decks already carry clean ST-xx set ids that cannot clash with
      // booster ids, so they only need marking as non-pack product.
      try {
        rows = rows.concat((await deckRes.json()).map(c =>
          Object.assign({}, c, { productKind: 'deck' })));
      } catch (_) {}
    }
    if (promoRes && promoRes.ok) {
      try {
        rows = rows.concat((await promoRes.json()).map(c => Object.assign({}, c, {
          productKind: 'promo',
          // Promos keep their ORIGINATING set in set_id ("OP09"), which both
          // collides with booster ids and would drop judge cards into pack
          // pools. 296 of them already share a card_image_id with a booster
          // card, so they get their own namespace and the origin is preserved
          // separately for display.
          originSet: c.set_id,
          set_id: D.PROMO_SET
        })));
      } catch (_) {}
    }

    // Trim before caching — card_text is most of the payload and we never use it.
    const slim = rows.map(c => ({
      card_set_id: c.card_set_id,
      card_image_id: c.card_image_id,
      card_name: c.card_name,
      set_id: c.set_id,
      set_name: c.set_name,
      rarity: c.rarity,
      market_price: c.market_price,
      inventory_price: c.inventory_price,
      card_color: c.card_color,
      card_type: c.card_type,
      card_image: c.card_image,
      date_scraped: c.date_scraped,
      // DON!! only — undefined on normal cards and dropped by JSON.stringify.
      donBooster: c.donBooster,
      donProduct: c.donProduct,
      donVariant: c.donVariant,
      // Non-booster product: 'deck' | 'promo', undefined for pack cards.
      productKind: c.productKind,
      originSet: c.originSet
    }));
    const at = new Date().toISOString();
    save(KEY.cards, { at, rows: slim });
    applyCards(slim, at);
    return { fromCache: false };
  }

  function applyCards(rows, at) {
    S.fetchedAt = at;
    S.bySet = {};
    S.byKey = {};
    // A handful of records arrive twice, byte-identical (four across 5,292 —
    // two ST-25 cards, a Gecko Moria). Harmless individually, but a duplicate
    // sits in its slot pool twice and skews that slot's average, so they are
    // collapsed on the way in.
    const deduped = [];
    for (const c of rows) {
      const k = E.cardKey(c);
      if (S.byKey[k]) continue;
      S.byKey[k] = c;
      deduped.push(c);
      (S.bySet[c.set_id] = S.bySet[c.set_id] || []).push(c);
    }
    S.cards = deduped;
    S.browseSets = null;        // rebuilt lazily from the new card data
    invalidate();
  }

  /**
   * Booster products only. Everything that computes odds, box EV or supply
   * signals uses this — a starter deck has no pull rate and a judge card
   * cannot come out of a pack.
   */
  function liveSets() {
    return D.SETS.filter(s => (S.bySet[s.id] || []).length > 0);
  }

  /**
   * Every product with cards, including starter decks and promos, for
   * browsing and collecting. Built from the fetched data rather than a
   * hardcoded list so new decks appear without a code change.
   */
  function browseSets() {
    if (S.browseSets) return S.browseSets;

    const extra = [];
    const seen = {};
    for (const c of S.cards) {
      if (!c.productKind || seen[c.set_id]) continue;
      seen[c.set_id] = true;
      extra.push({
        id: c.set_id,
        name: c.productKind === 'promo' ? 'Promos, winners, judge & event cards'
                                        : (c.set_name || c.set_id),
        short: c.productKind === 'promo' ? 'PROMO' : c.set_id.replace('-', ''),
        kind: c.productKind
      });
    }
    extra.sort((a, b) => a.kind === b.kind ? a.id.localeCompare(b.id)
                                           : (a.kind === 'promo' ? -1 : 1));
    S.browseSets = liveSets().concat(extra);
    return S.browseSets;
  }

  /* ========================================================== RIP vs BUY == */

  const poolOf = setId => indexFor(setId).all;

  /**
   * Every card in a product, for browsing and collecting — including the ones
   * that can never be pulled. buildSetIndex deliberately drops promos, box
   * toppers and non-booster DON!!, which is right for odds and wrong for a
   * collection: you still own the judge card.
   */
  function browsePool(setId) {
    const meta = setMeta(setId);
    if (meta && meta.kind && meta.kind !== 'booster') {
      const ck = 'browse|' + setId;
      if (S.indexCache[ck]) return S.indexCache[ck];
      const rows = (S.bySet[setId] || []).map(c => ({
        card: c, key: E.cardKey(c), price: priceOf(c),
        slot: null, variantLabel: E.classify(c).variantLabel || null
      })).sort((a, b) => b.price - a.price);
      S.indexCache[ck] = rows;
      return rows;
    }
    const idx = indexFor(setId);
    // Booster sets: pullable cards first, then the excluded ones so a box
    // topper you own is still findable.
    return idx.all.concat(idx.excluded.map(x => ({
      card: x.card, key: E.cardKey(x.card), price: priceOf(x.card),
      slot: null, variantLabel: x.reason || null
    })));
  }

  /**
   * With no query, show the selected set's pack pool.
   *
   * With a query, search EVERY set — because a card's number does not tell you
   * which pack it comes out of. OP08-106 Nami (SP) is pulled from OP-09 boxes,
   * so hunting for it inside OP-08 finds nothing. Searching only the open set
   * hides exactly the cards people go looking for.
   */
  /** Everything in scope, before the rarity and colour filters are applied. */
  function ripBasePool() {
    const q = S.ripSearch.trim().toLowerCase();
    let rows;
    if (!q) {
      rows = poolOf(S.ripSet);
    } else {
      rows = [];
      for (const s of liveSets()) {
        for (const e of poolOf(s.id)) {
          if (e.card.card_name.toLowerCase().includes(q) ||
              e.card.card_set_id.toLowerCase().includes(q)) {
            rows.push(Object.assign({ fromSet: s.id }, e));
          }
        }
      }
    }
    return rows;
  }

  function ripCardOptions() {
    const q = S.ripSearch.trim().toLowerCase();
    const slot = S.ripRarity || 'all';
    let rows;

    if (!q) {
      rows = poolOf(S.ripSet);
    } else {
      rows = [];
      for (const s of liveSets()) {
        for (const e of poolOf(s.id)) {
          if (e.card.card_name.toLowerCase().includes(q) ||
              e.card.card_set_id.toLowerCase().includes(q)) {
            rows.push(Object.assign({ fromSet: s.id }, e));
          }
        }
      }
    }
    // Chase tiers are what you actually hunt; commons make the list unusable.
    if (slot === 'chase') rows = rows.filter(e =>
      ['SEC', 'ALT', 'SP', 'MANGA', 'ULTRA', 'TR'].indexOf(e.slot) > -1);
    else if (slot !== 'all') rows = rows.filter(e => e.slot === slot);

    // Colour stacks with rarity rather than replacing it. Multicolour cards
    // match every colour they contain, which is how a player thinks about them.
    const col = S.ripColor || 'all';
    if (col !== 'all') {
      rows = rows.filter(e => hasColor(e.card, col));
    }

    rows.sort((a, b) => b.price - a.price);
    return rows;
  }

  /** Could this card have come out of a booster pack at all? */
  function isPullable(key) {
    const card = S.byKey[key];
    if (!card) return false;
    const meta = D.SETS.find(s => s.id === card.set_id);
    return !!meta && E.classify(card).slot !== null;
  }

  const hasColor = (card, color) =>
    (card.card_color || '').split(/\s+/).indexOf(color) > -1;

  /**
   * Both filters stack, so each is counted against the OTHER's current
   * selection — picking Red then opening Rarity shows how many Red alt arts
   * exist, not how many alt arts exist overall.
   */
  function renderRarityFilter() {
    const raritySel = $('#rip-rarity'), colorSel = $('#rip-color');
    if (!raritySel || !colorSel) return;

    const base = ripBasePool();
    const color = S.ripColor || 'all';
    const slot = S.ripRarity || 'all';
    const chaseKeys = ['SEC', 'ALT', 'SP', 'MANGA', 'ULTRA', 'TR'];

    // ---- rarity options, counted within the chosen colour
    const forRarity = color === 'all' ? base : base.filter(e => hasColor(e.card, color));
    const rCounts = {};
    for (const e of forRarity) rCounts[e.slot] = (rCounts[e.slot] || 0) + 1;
    const chaseCount = chaseKeys.reduce((s, k) => s + (rCounts[k] || 0), 0);

    const rOpts = [
      `<option value="all">All rarities (${forRarity.length})</option>`,
      `<option value="chase">Chase only (${chaseCount})</option>`
    ];
    for (const sl of D.SLOTS) {
      if (!rCounts[sl.key]) continue;                 // hide what is not there
      rOpts.push(`<option value="${esc(sl.key)}">${esc(sl.label)} (${rCounts[sl.key]})</option>`);
    }
    raritySel.innerHTML = rOpts.join('');
    raritySel.value = slot;
    // The chosen rarity may not exist in this colour — fall back rather than
    // silently showing an empty grid.
    if (raritySel.value !== slot) { S.ripRarity = 'all'; raritySel.value = 'all'; }

    // ---- colour options, counted within the chosen rarity
    const forColor = slot === 'all' ? base
      : slot === 'chase' ? base.filter(e => chaseKeys.indexOf(e.slot) > -1)
      : base.filter(e => e.slot === slot);
    const cCounts = {};
    for (const e of forColor) {
      for (const c of D.COLORS) if (hasColor(e.card, c)) cCounts[c] = (cCounts[c] || 0) + 1;
    }
    const cOpts = [`<option value="all">All colours (${forColor.length})</option>`];
    for (const c of D.COLORS) {
      if (!cCounts[c]) continue;
      cOpts.push(`<option value="${esc(c)}">${esc(c)} (${cCounts[c]})</option>`);
    }
    colorSel.innerHTML = cOpts.join('');
    colorSel.value = color;
    if (colorSel.value !== color) { S.ripColor = 'all'; colorSel.value = 'all'; }
  }

  function renderRipControls() {
    const sets = liveSets();
    if (!S.ripSet || !sets.some(s => s.id === S.ripSet)) S.ripSet = sets.length ? sets[sets.length - 1].id : null;

    $('#rip-set').innerHTML = sets.map(s =>
      `<option value="${esc(s.id)}"${s.id === S.ripSet ? ' selected' : ''}>${esc(s.short)} · ${esc(s.name)}</option>`
    ).join('');

    renderRarityFilter();
    const opts = ripCardOptions();
    if (!S.ripCard || !opts.some(o => o.key === S.ripCard)) S.ripCard = opts.length ? opts[0].key : null;

    // A card game deserves card art, not a 155-row text dropdown. Same grid
    // component as the collection picker, so both places behave identically.
    const searching = !!S.ripSearch.trim();
    $('#rip-count').textContent = opts.length
      ? opts.length + (searching ? ' across all sets' : ' cards') : '';

    $('#rip-grid').innerHTML = opts.slice(0, 150).map(e => `
      <div class="pick${e.key === S.ripCard ? ' sel' : ''}" data-key="${esc(e.key)}"
           data-set="${esc(e.fromSet || S.ripSet)}"
           title="${esc(e.card.card_name)}${e.variantLabel ? ' — ' + esc(e.variantLabel) : ''}${
             e.fromSet ? ' — pulled from ' + esc(setShort(e.fromSet)) + ' packs' : ''}">
        ${cardArt(e.card)}
        <div class="pmeta"><span class="pp">${E.money(e.price)}</span>${rarityChip(e.card)}</div>
        <div class="pn">${searching ? esc(setShort(e.fromSet)) + ' · ' : ''}${esc(e.card.card_set_id)}</div>
      </div>`).join('') || `<div class="small muted">No cards match.</div>`;

    $$('#rip-grid .pick').forEach(el => el.addEventListener('click', () => {
      if (el.dataset.key === S.ripCard) return;
      // A search hit may live in a different set's pool — follow it there, or
      // the odds lookup would run against the wrong box.
      if (el.dataset.set && el.dataset.set !== S.ripSet) S.ripSet = el.dataset.set;
      S.ripCard = el.dataset.key;
      renderRip();
      const sel = $('#rip-grid .pick.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }));

    fitGridRows('#rip-grid', 2);
  }

  /**
   * Verdict from odds and price alone — no box cost, no resale assumptions.
   *
   * The question "should I rip or buy this card" really only needs two facts:
   * how many packs it takes to expect one, and what the card costs. Thresholds
   * are in boxes because that is the unit you actually buy in.
   */
  function oddsVerdict(expectedPacks, packsPerBox, single) {
    const boxes = expectedPacks / packsPerBox;
    if (single < 2)  return { code: 'TRIVIAL',  title: 'NOT A CHASE' };
    if (boxes <= 2)  return { code: 'RIP',      title: 'RIP FOR IT' };
    if (boxes <= 10) return { code: 'COINFLIP', title: 'YOUR CALL' };
    return { code: 'BUY', title: 'BUY THE SINGLE' };
  }

  function renderRip() {
    renderRipControls();
    const out = $('#rip-out');

    if (!S.ripSet || !S.ripCard) {
      out.innerHTML = panelMsg('Pick a card to see its odds and price trend.');
      return;
    }

    const idx  = indexFor(S.ripSet);
    const cfg  = configFor(S.ripSet);
    const prob = E.perPackProbability(idx, cfg, S.ripCard);

    if (!prob) { out.innerHTML = panelMsg('That card is not in this set&rsquo;s pack pool.'); return; }

    const card   = prob.entry.card;
    const single = prob.entry.price;
    const packs  = cfg.packsPerBox;
    const stale  = E.staleness(card, null);

    if (prob.impossible) {
      out.innerHTML = panelMsg(
        `<b>${esc(card.card_name)}</b> sits in the <b>${esc(prob.slot)}</b> slot, which your current pull
         rates set to zero per box — so it cannot be pulled from this product at all.
         If that is wrong, raise it in Settings.`);
      return;
    }

    const expectedPacks = 1 / prob.p;
    const packsFor = q => Math.log(1 - q) / Math.log(1 - prob.p);
    const packs90 = packsFor(0.9);
    const pPerBox = 1 - Math.pow(1 - prob.p, packs);
    const boxesToHit = expectedPacks / packs;

    const v = oddsVerdict(expectedPacks, packs, single);

    const verdictLine =
      v.code === 'TRIVIAL'
        ? `At <b>${E.money(single)}</b> this card costs about the same as a pack. There is no chase to run —
           buy it, and rip for the cards actually worth hunting.`
      : v.code === 'RIP'
        ? `About <b>${boxesToHit.toFixed(1)} boxes</b> to expect one. That is well inside normal ripping,
           so you will run into it on your own.`
      : v.code === 'COINFLIP'
        ? `About <b>${boxesToHit.toFixed(1)} boxes</b> to expect one. Reachable if you were opening this set
           anyway — a bad plan if you are only after this card.`
        : `About <b>${Math.round(boxesToHit)} boxes</b> to expect one, and <b>${Math.round(packs90 / packs)}</b>
           to be 90% sure. Those are lottery odds. At <b>${E.money(single)}</b>, buy it.`;

    const owned = ownedSummary(S.ripCard);
    const sig = E.spreadSignal(card);
    const fitNote = configWarning(idx, cfg);

    out.innerHTML = `
      <div class="panel" style="margin-bottom:18px">
        <div class="panel-b">
          <div class="cardhero">
            ${card.card_image
              ? `<img src="${esc(card.card_image)}" alt="${esc(card.card_name)}" loading="lazy"
                     class="zoomable" id="hero-img" tabindex="0" role="button"
                     title="Click to enlarge">`
              : `<div class="noart" id="hero-img" title="${esc(card.card_name)} — no image in the source data">
                   <span>no image<br>available</span></div>`}
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                <span class="tag slot-${esc(prob.slot)}">${esc(prob.entry.variantLabel || (D.RARITY[prob.slot] || {}).label || prob.slot)}</span>
                <span class="mono small muted">${esc(card.card_set_id)}</span>
                ${stale != null && stale > 21 ? `<span class="tag est">price ${stale}d old</span>` : ''}
                ${owned ? `<span class="tag" style="color:var(--up);border-color:#2a6b4a">✓ you own ${owned.qty}</span>` : ''}
              </div>
              <h3 class="cardtitle" title="${esc(card.card_name)}">${esc(card.card_name)}</h3>
              <div class="small muted setline">
                ${esc(setShort(S.ripSet))} · ${esc(setName(S.ripSet))}
                ${reprintNote(card, S.ripSet)}
              </div>

              <div class="grid g-2" style="gap:12px;margin-bottom:14px">
                ${stat('Market price', E.money(single), sig ? `floor ${E.money(sig.inventory)} · ${E.pct(sig.ratio,0)} of market` : '')}
                ${stat('Supply', sig ? sig.state : '—',
                       sig ? (sig.state === 'TIGHT' || sig.state === 'FIRMING'
                              ? 'cheap copies drying up' : 'cheap copies still around') : 'no floor data')}
              </div>

              <div class="verdict ${v.code}" style="text-align:left">
                <div class="lbl">Verdict</div>
                <div class="big">${v.title}</div>
                <div class="sub">${verdictLine}</div>
                ${owned ? `<div class="sub muted" style="margin-top:9px;font-size:12.5px">
                  You already have <b>${owned.qty}</b> in ${esc(owned.where)}.</div>` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid g-3" style="margin-bottom:18px">
        ${stat('Odds per pack', E.odds(prob.p), `${E.pct(prob.p, 3)} · ${prob.poolSize} cards share the ${esc(prob.slot)} slot`)}
        ${stat('Chance per box', E.pct(pPerBox), `${packs} packs per box`)}
        ${stat('Boxes to 90% odds', Math.ceil(packs90 / packs).toLocaleString(), `${Math.round(packs90).toLocaleString()} packs`)}
      </div>

      ${fitNote}

      <div class="panel" id="hist-panel">
        <div class="panel-h"><h2>13-day price history</h2>
          <span class="small muted" style="margin-left:auto" id="hist-note">loading…</span></div>
        <div class="panel-b" id="hist-body"><div class="small muted">Fetching…</div></div>
      </div>

      <div class="note small" style="margin-top:18px">
        Odds assume every card in the <b>${esc(prob.slot)}</b> slot is equally likely — Bandai does not publish
        per-card weighting, so nobody can do better than that. Real boxes are also not independent:
        hits are distributed per box, which makes a single box slightly more predictable than this model,
        and a long chase across many boxes slightly less.
      </div>`;

    const hero = $('#hero-img');
    // A placeholder has nothing to enlarge, so it is not made clickable.
    if (hero && card.card_image) {
      hero.addEventListener('click', () => openLightbox(card));
      hero.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(card); }
      });
    }

    loadHistory(card);
  }

  /* ---- full-size card view ---------------------------------------------- */
  function openLightbox(card) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-bg lightbox" id="lb">
        <figure class="lb-fig">
          <img src="${esc(card.card_image)}" alt="${esc(card.card_name)}"
               onerror="this.style.visibility='hidden'">
          <figcaption>
            <b>${esc(card.card_name)}</b>
            <span>${esc(card.card_set_id)} · ${esc(setName(card.set_id))}</span>
          </figcaption>
        </figure>
        <button class="lb-close" id="lb-close" aria-label="Close">×</button>
      </div>`;

    const close = () => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      const hero = $('#hero-img');
      if (hero) hero.focus();          // put focus back where it came from
    };
    const onKey = e => { if (e.key === 'Escape') close(); };

    document.addEventListener('keydown', onKey);
    $('#lb-close').addEventListener('click', close);
    // Click the backdrop to dismiss, but not the card itself.
    $('#lb').addEventListener('click', e => { if (e.target.id === 'lb') close(); });
    $('#lb-close').focus();
  }

  /**
   * A card numbered for one set but pulled from another's packs.
   *
   * This is normal — SP and reprint chases are seeded into later sets — but it
   * is genuinely confusing, because looking for OP08-106 Nami (SP) inside OP-08
   * finds nothing: it comes out of OP-09 boxes. Say so on the card rather than
   * letting the number and the set silently disagree.
   */
  function reprintNote(card, setId) {
    // DON!! cards carry no set number, so there is nothing to disagree about.
    if (card.rarity === 'DON') return '';
    const numbered = (card.card_set_id || '').split('-')[0];
    const from = String(setId).replace('-', '').replace(/EB0?4$/, '');
    if (!numbered || numbered === from) return '';
    return `<br><span class="tag est" style="margin-top:5px;display:inline-block">
      numbered ${esc(numbered)} · pulled from ${esc(setShort(setId))} packs</span>`;
  }

  /** Do I already own this card, and where? Drives the "you own N" badge. */
  function ownedSummary(key) {
    const mine = C.live(S.items).filter(it => it.key === key);
    if (!mine.length) return null;
    const qty = mine.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    if (!qty) return null;
    const names = [];
    for (const it of mine) {
      const col = S.cols.find(c => c.id === it.colId);
      const n = col ? col.name : 'a binder';
      if (names.indexOf(n) === -1) names.push(n);
    }
    return { qty, where: names.join(' and ') };
  }

  /**
   * Banner for products whose pack structure Bandai never published, or whose
   * pull-rate config does not fit the set's actual card pool.
   */
  function configWarning(idx, cfg) {
    const fit = E.configFit(idx, cfg);
    if (cfg.verified && fit.ok && !fit.issues.length) return '';

    const bits = [];
    if (!cfg.verified) {
      bits.push(`<b>${esc(cfg.label)} structure is not officially documented.</b>
        Pack and box counts are confirmed, but the rarity split per pack is inferred from the
        set's own card pool. Treat this set's expected value as a rough read, not a number to
        buy a case on.`);
    }
    for (const i of fit.issues) bits.push(esc(i.message));

    return `<div class="note warn small" style="margin-bottom:18px">${bits.join('<br>')}</div>`;
  }

  const panelMsg = html => `<div class="panel"><div class="panel-b muted">${html}</div></div>`;

  function stat(k, v, s, cls) {
    return `<div class="stat${cls ? ' ' + cls : ''}">
      <div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  }

  /* ---------------------------------------------------- price history ---
     The whole Rip panel re-renders on every keystroke and every drag of the
     friction slider. Without a cache that meant one API call per render — a
     single slider sweep could fire dozens of requests for data that had not
     changed. Results are memoised per card, and an in-flight promise is stored
     so concurrent renders share one request instead of racing.                */

  /**
   * cardKey -> settled result, or a pending Promise.
   *
   * Seeded from localStorage so a full scan survives a reload. Without that,
   * scanning 342 cards took ~8s and was thrown away the moment you refreshed —
   * the request cost was being paid over and over for data that changes once a
   * day. Entries carry their own timestamp and expire individually.
   */
  const HIST_TTL = 12 * 3600 * 1000;   // prices move daily; half a day is plenty
  const HIST = {};

  (function seedHistFromDisk() {
    const raw = load(KEY.hist, null);
    if (!raw || !raw.e) return;
    const now = Date.now();
    for (const k in raw.e) {
      const rec = raw.e[k];
      if (rec && rec.t && now - rec.t < HIST_TTL && rec.h) HIST[k] = { ok: true, h: rec.h, t: rec.t };
    }
  })();

  let histDirty = false, histSaveTimer = null;
  function persistHist(immediate) {
    histDirty = true;
    clearTimeout(histSaveTimer);
    const run = () => {
      if (!histDirty) return;
      histDirty = false;
      const now = Date.now(), e = {};
      for (const k in HIST) {
        const v = HIST[k];
        // Promises and failures are never persisted.
        if (!v || typeof v.then === 'function' || !v.ok || !v.h) continue;
        const t = v.t || now;
        if (now - t < HIST_TTL) e[k] = { t, h: v.h };
      }
      save(KEY.hist, { e });      // non-critical: worst case it rescans
    };
    if (immediate) run(); else histSaveTimer = setTimeout(run, 1200);
  }

  async function fetchHistory(card) {
    try {
      const res = await fetch(D.API.history(card.card_set_id));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = await res.json();
      // card_set_id is shared by base + parallel prints; match the exact variant.
      const row = rows.find(x => x.card_image_id === card.card_image_id) || rows[0];
      const h = row ? E.parseHistory(row) : null;
      return h ? { ok: true, h } : { ok: false, msg: 'Not enough data points.' };
    } catch (err) {
      return { ok: false, msg: 'Could not load history (' + err.message + ').', retry: true };
    }
  }

  function paintHistory(result) {
    const note = $('#hist-note'), body = $('#hist-body');
    if (!note || !body) return;

    if (!result.ok) {
      note.textContent = result.retry ? 'unavailable' : 'no history';
      body.innerHTML = `<div class="small muted">${esc(result.msg)}</div>`;
      return;
    }
    const h = result.h;

    if (h.frozen) {
      note.innerHTML = `<span class="muted">no movement recorded</span>`;
      body.innerHTML = `
        <div class="note warn small">
          <strong>This price has not changed once in 13 days.</strong>
          TCGplayer's market price is a rolling average of <em>recent completed sales</em>,
          so an identical figure every day almost always means the card has not been
          repriced — not that the market is steady. Expensive chase cards trade rarely,
          which is exactly why they go stale: 32 of the cards over $50 in this database
          were last priced more than 180 days ago.
          Treat <b>${E.money(h.last)}</b> as a last-known figure, not a live one.
        </div>`;
      return;
    }

    const dir = h.changePct >= 0 ? 'up' : 'down';
    note.innerHTML = `<span class="${dir}">${h.changePct >= 0 ? '▲' : '▼'} ${E.pct(Math.abs(h.changePct))}</span> over 13 days`;
    body.innerHTML = `
      <div class="grid g-4" style="margin-bottom:14px">
        ${stat('Now', E.money(h.last))}
        ${stat('13 days ago', E.money(h.first))}
        ${stat('Range', E.money(h.min) + ' – ' + E.money(h.max))}
        ${stat('Volatility', E.pct(h.volatility))}
      </div>
      ${sparkline(h.series, h.changePct >= 0)}`;
  }

  /**
   * DON!! cards carry the literal string "DON" as their card id, so the
   * per-card history endpoint 404s for every one of them. Left unguarded they
   * failed, got evicted for retry, and were re-requested on every single scan —
   * 42 wasted calls a sweep, permanently, against a free API.
   */
  const hasHistory = card =>
    card.rarity !== 'DON' && !!card.card_set_id && card.card_set_id !== 'DON';

  /** Fill the cache for one card. No DOM. Shared by the panel and the scanner. */
  async function loadHistoryFor(card) {
    const key = E.cardKey(card);

    if (!hasHistory(card)) {
      // Settled and non-retryable, so it is asked for exactly once.
      return (HIST[key] = { ok: false, noHistory: true,
        msg: 'DON!! cards have no per-card price history in this API.' });
    }

    const cached = HIST[key];
    if (cached && typeof cached.then !== 'function') return cached;

    // Either join the in-flight request or start one.
    const pending = cached || (HIST[key] = fetchHistory(card));
    const result = await pending;
    if (result.ok) result.t = Date.now();
    HIST[key] = result;
    // A failed lookup should not be cached forever — let the next visit retry.
    if (!result.ok && result.retry) delete HIST[key];
    else if (result.ok) persistHist();
    return result;
  }

  async function loadHistory(card) {
    if (!$('#hist-body')) return;
    const key = E.cardKey(card);
    const settled = HIST[key];
    if (settled && typeof settled.then !== 'function') { paintHistory(settled); return; }

    const result = await loadHistoryFor(card);
    // The user may have moved on while this was in flight; don't stomp the panel.
    if (S.ripCard === key) paintHistory(result);
  }

  function sparkline(series, rising) {
    const w = 100, h = 30, pad = 2;
    const min = Math.min.apply(null, series), max = Math.max.apply(null, series);
    const span = (max - min) || 1;
    const pts = series.map((v, i) => {
      const x = pad + (i / (series.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return x.toFixed(2) + ',' + y.toFixed(2);
    });
    const col = rising ? 'var(--up)' : 'var(--down)';
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="13 day price trend">
      <polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.1"
                stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  /* ======================================================= SET EXPLORER == */

  function setRows() {
    return liveSets().map(s => {
      const idx  = indexFor(s.id);
      const cfg  = configFor(s.id);
      const ev   = E.evaluate(idx, cfg);
      const conc = E.chaseConcentration(idx, cfg, 5);
      const box  = boxPrice(s.id);
      return {
        id: s.id, name: s.name, short: s.short,
        box, evBox: ev.evBox, evPack: ev.evPack,
        roi: box > 0 ? ev.evBox / box - 1 : null,
        conc: conc.share,
        // idx.all is sorted by price descending, so [0] IS the most expensive
        // card. This used to read conc.all[0], which is sorted by EV
        // CONTRIBUTION (copies per box x price) — so a cheap card with good
        // odds outranked the real chase and OP-09 reported $120 instead of
        // its $5,500 Gol.D.Roger (Manga).
        best: idx.all.length ? idx.all[0].price : 0,
        bestCard: idx.all.length ? idx.all[0] : null,
        // What one copy of every card at or above the floor would cost you.
        over5: idx.all.reduce((s, e) => e.price >= 5 ? s + e.price : s, 0),
        over5Count: idx.all.reduce((n, e) => e.price >= 5 ? n + 1 : n, 0),
        cards: (S.bySet[s.id] || []).length,
        est: boxIsEstimate(s.id),
        unverified: !cfg.verified || !E.configFit(idx, cfg).ok
      };
    });
  }

  function renderSets() {
    const tbody = $('#sets-tbl tbody');
    const rows = setRows();
    const { by, dir } = S.sort.sets;
    rows.sort((a, b) => {
      const av = a[by], bv = b[by];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * dir;
    });

    $('#sets-sub').textContent = rows.length + ' sets · ' + S.cards.length.toLocaleString() + ' cards';
    tbody.innerHTML = rows.map(r => `
      <tr class="clickable" data-set="${esc(r.id)}">
        <td><b>${esc(r.short)}</b> <span class="muted small">${esc(r.name)}</span>
          ${r.unverified ? ' <span class="tag est" title="Pack structure is not officially documented — expected value here is a rough read">?</span>' : ''}</td>
        <td class="num">${E.money(r.box)}${r.est ? ' <span class="tag est">EST</span>' : ''}</td>
        <td class="num">${E.money(r.evBox)}</td>
        <td class="num">${E.money(r.evPack)}</td>
        <td class="num ${r.roi == null ? '' : r.roi >= 0 ? 'up' : 'down'}">
          <b>${r.roi == null ? '—' : (r.roi >= 0 ? '+' : '') + E.pct(r.roi, 0)}</b></td>
        <td class="num">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <span>${E.pct(r.conc, 0)}</span>
            <span class="bar brass" style="width:52px"><i style="width:${Math.min(100, r.conc * 100).toFixed(0)}%"></i></span>
          </div></td>
        <td class="num">${E.money(r.best)}${r.bestCard
          ? `<div class="small muted" style="font-weight:400">${esc(r.bestCard.card.card_name.slice(0, 22))}</div>` : ''}</td>
        <td class="num">${E.money(r.over5)}
          <div class="small muted" style="font-weight:400">${r.over5Count} cards</div></td>
        <td class="num muted">${r.cards}</td>
      </tr>`).join('');

    $$('#sets-tbl tbody tr').forEach(tr => tr.addEventListener('click', () => {
      S.ripSet = tr.dataset.set; S.ripCard = null; S.ripSearch = '';
      $('#rip-search').value = '';
      switchTab('rip');
    }));
  }

  /* ============================================================ SIGNALS == */

  /* Rank drives the default sort: actionable and confirmed first, noise last. */
  const TAG_RANK = { BUY: 5, TRIM: 4, HOLD: 3, WATCH: 2, AVOID: 1, STALE: -1 };

  function signalRows() {
    const min   = Number($('#sig-min').value) || 0;
    const only  = $('#sig-set').value;
    const scope = $('#sig-scope').value;

    // Which cards do I own, and which are earmarked to sell?
    const ownedAny = {}, ownedTrade = {};
    for (const it of C.live(S.items)) {
      ownedAny[it.key] = true;
      const col = S.cols.find(c => c.id === it.colId);
      if (col && col.kind === 'trade') ownedTrade[it.key] = true;
    }

    const out = [];
    for (const s of liveSets()) {
      if (only !== 'all' && only !== s.id) continue;
      // Pre-sorted by price descending, so the first entry below the floor
      // means every remaining entry is too.
      const entries = indexFor(s.id).all;
      for (const e of entries) {
        {
          if (e.price < min) break;
          if (scope === 'owned' && !ownedAny[e.key]) continue;
          if (scope === 'trade' && !ownedTrade[e.key]) continue;

          const sig = E.spreadSignal(e.card);
          if (!sig) continue;
          const age = E.staleness(e.card, null);

          // History is only present for cards already scanned — the tag
          // degrades to WATCH rather than guessing.
          const cached = HIST[e.key];
          const hist = (cached && typeof cached.then !== 'function' && cached.ok) ? cached.h : null;

          const tag = E.actionTag({
            sig, age, hist,
            owned: !!ownedAny[e.key],
            ownedTrade: !!ownedTrade[e.key]
          });

          out.push({
            entry: e, sig, setId: s.id, hist, tag,
            market: sig.market, inv: sig.inventory,
            ratio: sig.ratio, score: sig.score, age,
            change: hist ? hist.changePct : null,
            rank: tag ? (TAG_RANK[tag.code] || 0) : 0
          });
        }
      }
    }
    return out;
  }

  /**
   * Fetch 13-day history for the rows on screen so calls can use momentum.
   * Concurrency-capped — 300 parallel requests would get us rate-limited and
   * the results are memoised, so a second scan is nearly free.
   */
  /**
   * Scan every row currently in view — no cap.
   *
   * The old 60-card limit was over-cautious: one request measures ~135ms, so
   * at 6 in flight the full $50+ list (342 cards) finishes in about 8 seconds
   * and the $20+ list (540) in twelve. Results are cached to disk for 12h, so
   * this is paid once a day rather than once a page load.
   *
   * Concurrency stays at 6 deliberately. This is someone else's free API and
   * there is no reason to open 300 sockets to save four seconds.
   */
  const SCAN_CONCURRENCY = 6;

  async function scanTrends(rows) {
    const btn = $('#sig-scan');
    if (S.scanning) { S.scanAbort = true; return; }   // second click = stop

    const todo = rows.filter(r => hasHistory(r.entry.card) && !HIST[r.entry.key]);
    if (!todo.length) { renderSignals(); return; }

    S.scanning = true; S.scanAbort = false;
    btn.classList.add('scanning');
    let done = 0;
    const queue = todo.slice();
    const total = todo.length;

    // Repaint periodically so calls appear as they resolve instead of the
    // table sitting frozen for eight seconds.
    let lastPaint = 0;
    const tick = () => {
      btn.textContent = `Stop (${done}/${total})`;
      if (Date.now() - lastPaint > 1500) { lastPaint = Date.now(); renderSignals(); }
    };

    async function worker() {
      while (queue.length && !S.scanAbort) {
        const r = queue.shift();
        try { await loadHistoryFor(r.entry.card); } catch (_) {}
        done++;
        tick();
      }
    }
    const workers = [];
    for (let i = 0; i < SCAN_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);

    S.scanning = false;
    btn.classList.remove('scanning');
    btn.textContent = 'Scan trends';
    persistHist(true);
    renderSignals();
  }

  function renderSignals() {
    const tbody = $('#sig-tbl tbody');
    const stats = $('#sig-stats');

    const rows = signalRows();
    const fresh = rows.filter(r => !(r.age != null && r.age > E.STALE_DAYS));
    const tight = fresh.filter(r => r.sig.state === 'TIGHT' || r.sig.state === 'FIRMING');
    const stale = rows.length - fresh.length;
    const scanned = rows.filter(r => r.hist).length;
    // DON!! rows can never be scanned, so counting them as outstanding would
    // leave the tab permanently reporting work it will never do.
    const scannable = rows.filter(r => hasHistory(r.entry.card)).length;
    const pending = Math.max(0, scannable - scanned);
    const calls = rows.filter(r => r.tag && (r.tag.code === 'BUY' || r.tag.code === 'TRIM' || r.tag.code === 'HOLD'));

    stats.innerHTML =
      stat('Cards tracked', rows.length.toLocaleString(),
           stale ? `${stale} too stale to read` : 'all fresh') +
      stat('Tightening', tight.length.toLocaleString(), 'floor within 15% of market, fresh data') +
      stat('Calls', calls.length.toLocaleString(),
           scanned ? `from ${scanned} scanned trends` : 'scan trends to generate', 'hero') +
      stat('Trends loaded', `${scanned}/${scannable}`,
           rows.length > scannable ? `${rows.length - scannable} DON!! have no history feed`
                                   : 'momentum confirms supply');

    $('#sig-legend').innerHTML =
      `<b>MUST BUY</b> supply tightening + price rising, and you do not own it ·
       <b>HOLD</b> same, but you already own it ·
       <b>TRIM</b> in your trade binder, cheap copies everywhere and falling ·
       <b>WATCH</b> tightening but no trend loaded yet ·
       <b>STALE</b> last priced over ${E.STALE_DAYS} days ago, ignored.
       ${!pending
         ? `All ${scannable} scannable rows loaded — cached for 12 hours.`
         : `<b>${pending}</b> rows still need their 13-day trend before they can produce a
            call. <b>Scan trends</b> fetches every one of them (about
            ${Math.max(1, Math.round(pending / SCAN_CONCURRENCY * 0.135))}s), cached for 12 hours.`}`;

    const { by, dir } = S.sort.sig;
    rows.sort((a, b) => {
      const av = a[by], bv = b[by];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // nulls last regardless of direction
      if (bv == null) return -1;
      return (av - bv) * dir;
    });

    tbody.innerHTML = rows.slice(0, 400).map(r => {
      const c = r.entry.card;
      const isStale = r.tag && r.tag.code === 'STALE';
      return `<tr class="clickable${isStale ? ' rowstale' : ''}"
                  data-key="${esc(r.entry.key)}" data-set="${esc(r.setId)}">
        <td><div class="cardcell">
          <img src="${esc(c.card_image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="nm"><b>${esc(c.card_name)}</b><span>${esc(c.card_set_id)}</span></div>
        </div></td>
        <td><span class="tag">${esc(setShort(r.setId))}</span></td>
        <td class="num">${E.money(r.market)}</td>
        <td class="num muted">${E.money(r.inv)}</td>
        <td class="num">${E.pct(r.ratio, 0)}</td>
        <td class="num ${r.change == null ? 'muted' : r.change >= 0 ? 'up' : 'down'}">
          ${r.change == null ? '—' : (r.change >= 0 ? '+' : '') + E.pct(r.change, 1)}</td>
        <td class="num">${isStale ? '<span class="badge-state st-NORMAL">—</span>'
                                  : `<span class="badge-state st-${r.sig.state}">${r.sig.state}</span>`}</td>
        <td class="num">${r.tag ? `<span class="call call-${r.tag.code}" title="${esc(r.tag.why)}">${r.tag.label}</span>` : ''}</td>
        <td class="num muted small">${r.age == null ? '—' : r.age + 'd'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="9" class="muted">Nothing matches those filters.</td></tr>`;

    $$('#sig-tbl tbody tr[data-key]').forEach(tr => tr.addEventListener('click', () => {
      S.ripSet = tr.dataset.set; S.ripCard = tr.dataset.key; S.ripSearch = '';
      $('#rip-search').value = '';
      switchTab('rip');
    }));
  }

  /* =========================================================== SETTINGS == */

  function renderSettings() {
    // ---- box prices
    $('#box-editor').innerHTML = liveSets().map(s => {
      const est = boxIsEstimate(s.id);
      return `<label class="fld" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
          <b style="color:var(--ink)">${esc(s.short)}</b> ${esc(s.name)}
          ${est ? '<span class="tag est">EST</span>' : ''}
        </span>
        <input type="number" class="box-in" data-set="${esc(s.id)}" min="0" step="1"
               value="${boxPrice(s.id)}" style="width:110px;text-align:right;
               ${est ? '' : 'border-color:var(--brass);color:var(--brass)'}">
      </label>`;
    }).join('');

    $$('.box-in').forEach(inp => inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (isNaN(v) || v < 0) { renderSettings(); return; }
      S.boxes[inp.dataset.set] = v;
      save(KEY.boxes, S.boxes);
      renderSettings(); renderActive();
    }));

    // ---- pull rates
    const profSel = $('#pr-profile');
    if (!profSel.dataset.ready) {
      profSel.innerHTML =
        Object.keys(D.PROFILES).map(p =>
          `<option value="profile:${p}">${esc(D.PROFILES[p].label)} — all sets</option>`).join('') +
        `<option disabled>──────────</option>` +
        liveSets().map(s =>
          `<option value="set:${esc(s.id)}">${esc(s.short)} · ${esc(s.name)}${S.setRates[s.id] ? ' ✎' : ''}</option>`).join('');
      profSel.dataset.ready = '1';
      // Rebuilding the options resets the selection, which would bounce you
      // back to the profile every time you edited a per-set rate.
      if (S.rateScope) profSel.value = S.rateScope;
    }

    const scope   = profSel.value || 'profile:STANDARD';
    S.rateScope   = scope;
    const isSet   = scope.indexOf('set:') === 0;
    const scopeId = scope.slice(scope.indexOf(':') + 1);
    const prof    = isSet ? profileOf(scopeId) : scopeId;
    const base    = D.PROFILES[prof];

    // Editing a set shows its effective rates — profile defaults until you
    // change something, at which point only that set diverges.
    const eff    = isSet ? configFor(scopeId)
                         : Object.assign({}, base, S.rates[prof] || {},
                             { perBox: Object.assign({}, base.perBox, (S.rates[prof] || {}).perBox || {}) });
    const perBox = eff.perBox;
    const packs  = eff.packsPerBox;
    const setIdx = isSet ? indexFor(scopeId) : null;

    $('#rate-editor').innerHTML =
      `<label class="fld" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
          <b style="color:var(--ink)">Packs per box</b></span>
        <input type="number" id="pr-packs" min="1" step="1" value="${packs}" style="width:110px;text-align:right">
      </label>` +
      D.SLOTS.map(sl => {
        const inPool = setIdx && setIdx.slots[sl.key] ? setIdx.slots[sl.key].count : null;
        // When editing one set, show how many cards actually sit in each slot.
        // A rate for a slot this set does not have is just noise.
        const note = setIdx
          ? (inPool ? `<span class="small muted">${inPool} cards</span>`
                    : `<span class="small muted" style="opacity:.5">none in set</span>`)
          : '';
        return `
        <label class="fld" style="display:flex;align-items:center;gap:10px;margin-bottom:7px${
          setIdx && !inPool ? ';opacity:.4' : ''}">
          <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
            <span class="tag slot-${esc(sl.key)}">${esc(sl.label)}</span> ${note}</span>
          <input type="number" class="rate-in" data-slot="${esc(sl.key)}" min="0" step="0.01"
                 value="${perBox[sl.key] || 0}" style="width:110px;text-align:right">
        </label>`; }).join('');

    const total = D.SLOTS.reduce((s, sl) => s + (perBox[sl.key] || 0), 0);
    const should = packs * base.cardsPerPack;
    const off = Math.abs(total - should);
    $('#rate-sum').innerHTML =
      (isSet
        ? `Editing <b>${esc(setShort(scopeId))}</b> only.${eff.customised
             ? ' <span style="color:var(--brass)">Customised — no longer follows the profile.</span>'
             : ' Currently following the profile default; change any number to diverge.'}<br>`
        : `Editing every <b>${esc(base.label)}</b> set. Per-set overrides win over this.<br>`) +
      `Slots total <b class="mono">${total.toFixed(2)}</b> cards per box; the box physically holds
       <b class="mono">${should}</b>. ` +
      (off > 1
        ? `<span class="down">Off by ${off.toFixed(2)} — your EV will be skewed.</span>`
        : `<span class="up">Balanced.</span>`) +
      (isSet && eff.customised
        ? ` <button class="btn ghost small" id="pr-clear-set" style="margin-left:8px">Revert to profile</button>` : '');

    const commit = () => {
      const next = {};
      $$('.rate-in').forEach(i => { next[i.dataset.slot] = Math.max(0, parseFloat(i.value) || 0); });
      const packsPerBox = Math.max(1, parseInt($('#pr-packs').value, 10) || base.packsPerBox);
      if (isSet) {
        S.setRates[scopeId] = { perBox: next, packsPerBox };
        save(KEY.setRates, S.setRates);
        $('#pr-profile').dataset.ready = '';   // refresh the ✎ marker
      } else {
        S.rates[prof] = { perBox: next, packsPerBox };
        save(KEY.rates, S.rates);
      }
      invalidate();
      renderSettings(); renderActive();
    };
    $$('.rate-in').forEach(i => i.addEventListener('change', commit));
    $('#pr-packs').addEventListener('change', commit);
    const clr = $('#pr-clear-set');
    if (clr) clr.addEventListener('click', () => {
      delete S.setRates[scopeId];
      save(KEY.setRates, S.setRates);
      $('#pr-profile').dataset.ready = '';
      invalidate(); renderSettings(); renderActive();
    });

    // ---- data info
    $('#data-info').innerHTML =
      `<b>${S.cards.length.toLocaleString()}</b> cards across <b>${liveSets().length}</b> sets.<br>
       Last fetched: <b>${S.fetchedAt ? new Date(S.fetchedAt).toLocaleString() : 'never'}</b>.<br>
       Source: <a href="https://optcgapi.com/" target="_blank" rel="noopener">optcgapi.com</a> — English prices only.`;

  }

  /* ========================================================== COLLECTION == */

  /**
   * First run gets the two binders that actually change the advice, and they
   * are permanent — the whole app splits on keep vs trade (the supply signal
   * scope, the trade rate, the "you already own this" check), so losing either
   * one would leave features with nowhere to point.
   */
  function ensureCollections() {
    const live = S.cols.filter(c => !c.deleted);
    let changed = false;

    if (!live.length) {
      S.cols.push(Object.assign(C.newCollection('Keeping', 'keep'), { locked: 1 }));
      S.cols.push(Object.assign(C.newCollection('Trade / Sell', 'trade'), { locked: 1 }));
      changed = true;
    } else {
      // Migration for binders created before locking existed: the oldest of
      // each kind becomes the permanent one.
      for (const kind of ['keep', 'trade']) {
        const ofKind = live.filter(c => c.kind === kind);
        if (!ofKind.length) {
          S.cols.push(Object.assign(
            C.newCollection(kind === 'keep' ? 'Keeping' : 'Trade / Sell', kind), { locked: 1 }));
          changed = true;
        } else if (!ofKind.some(c => c.locked)) {
          ofKind.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          ofKind[0].locked = 1;
          ofKind[0].updatedAt = Date.now();
          changed = true;
        }
      }
    }
    if (changed) saveCritical(KEY.cols, S.cols);
  }

  const liveCols = () => S.cols.filter(c => !c.deleted);
  const itemsIn  = id => C.live(S.items).filter(it => it.colId === id);

  function currentCol() {
    const cols = liveCols();
    if (!cols.length) return null;
    let c = cols.find(x => x.id === S.curCol);
    if (!c) { c = cols[0]; S.curCol = c.id; }
    return c;
  }

  function renderCollection() {
    ensureCollections();
    const col = currentCol();
    renderBinders();
    renderSyncPanel();

    // ---- headline numbers across every binder
    const all = C.valueOf(C.live(S.items), priceForKey);
    const keepIds  = liveCols().filter(c => c.kind === 'keep').map(c => c.id);
    const tradeIds = liveCols().filter(c => c.kind === 'trade').map(c => c.id);
    const keep  = C.valueOf(C.live(S.items).filter(i => keepIds.indexOf(i.colId) > -1), priceForKey);
    const trade = C.valueOf(C.live(S.items).filter(i => tradeIds.indexOf(i.colId) > -1), priceForKey);

    // Trade stock valued at what a vendor would actually give for it. Each
    // binder carries its own rate because not every buyer offers the same.
    let tradeAtRate = 0;
    for (const c of liveCols()) {
      if (c.kind !== 'trade') continue;
      tradeAtRate += C.valueOf(itemsIn(c.id), priceForKey).total * (C.rateOf(c) / 100);
    }
    const blendedRate = trade.total > 0 ? Math.round(tradeAtRate / trade.total * 100) : null;

    $('#col-stats').innerHTML =
      stat('Total value', E.money(all.total), `${all.cards.toLocaleString()} cards at market`, 'hero') +
      stat('Keeping', E.money(keep.total), `${keep.cards.toLocaleString()} cards`) +
      stat('Trade / Sell', E.money(tradeAtRate),
           trade.total > 0
             ? `${E.money(trade.total)} market · at ${blendedRate}%`
             : `${trade.cards.toLocaleString()} cards`) +
      stat('Spent', all.cost > 0 ? E.money(all.cost) : '—',
           all.cost > 0
             ? `${all.gain >= 0 ? 'up' : 'down'} ${E.money(Math.abs(all.gain))}` +
               `${all.gainPct != null ? ' (' + E.pct(all.gainPct, 0) + ')' : ''}` +
               `${all.costComplete ? '' : ` · on ${all.costedCards} of ${all.cards} cards`}`
             : 'add what you paid to track this');

    renderAddGrid();
    renderScoreboard();
    renderColTable(col);
  }

  /* ---- rip scoreboard ---------------------------------------------------- */
  function renderScoreboard() {
    const sel = $('#op-set');
    if (sel && sel.dataset.filled !== '1') {
      sel.innerHTML = liveSets().map(s =>
        `<option value="${esc(s.id)}">${esc(s.short)} · ${esc(s.name)}</option>`).join('');
      sel.dataset.filled = '1';
    }

    const sb = C.scoreboard(S.opens, S.items, priceForKey, setShort,
                            id => !!D.SETS.find(s => s.id === id));
    const body = $('#score-body');
    if (!body) return;

    if (!sb.rows.length) {
      $('#score-sub').textContent = '';
      body.innerHTML = `<div class="small muted">
        Log a box you opened and mark its pulls, and this will tell you whether ripping has
        actually beaten buying singles — using what you really paid, not a model.</div>`;
      return;
    }

    const t = sb.total;
    $('#score-sub').innerHTML = `${t.boxes} boxes · ${E.money(t.spent)} spent`;

    // Spent money but logged nothing yet is unfinished bookkeeping, not a 100%
    // loss. Showing −100% here would be technically true and completely wrong.
    const pending = t.spent > 0 && t.pulledCards === 0;

    body.innerHTML = `
      <div class="grid g-4" style="gap:10px;margin-bottom:14px">
        ${stat('Spent on sealed', E.money(t.spent), `${t.boxes} boxes`)}
        ${stat('Pulled', pending ? '—' : E.money(t.pulledValue),
               pending ? 'nothing logged yet' : `${t.pulledCards} cards logged`)}
        ${pending
          ? stat('Net', '—', 'log your pulls to see this', 'hero')
          : stat('Net', (t.net >= 0 ? '+' : '−') + E.money(Math.abs(t.net)),
                 t.ret != null ? (t.ret >= 0 ? '+' : '') + E.pct(t.ret, 0) + ' return' : '', 'hero')}
        ${stat('Per box', (pending || !t.boxes) ? '—' : E.money(t.pulledValue / t.boxes), 'average pulled')}
      </div>
      <div class="tbl-scroll" style="max-height:260px">
        <table class="tbl"><thead><tr>
          <th>Set</th><th class="num">Boxes</th><th class="num">Spent</th>
          <th class="num">Pulled</th><th class="num">Net</th><th></th>
        </tr></thead><tbody>
        ${sb.rows.map(r => `<tr>
          <td><b>${esc(r.name)}</b></td>
          <td class="num">${r.boxes || '—'}</td>
          <td class="num">${E.money(r.spent)}</td>
          <td class="num">${E.money(r.pulledValue)}</td>
          <td class="num ${r.incomplete ? 'muted' : r.net >= 0 ? 'up' : 'down'}">
            <b>${r.incomplete ? '—' : (r.net >= 0 ? '+' : '−') + E.money(Math.abs(r.net))}</b></td>
          <td class="num small muted">${r.incomplete ? 'no pulls logged yet' : ''}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
      <div class="small muted" style="margin-top:10px">
        Only cards marked <b>pulled</b> count as winnings — singles you bought are not luck.
        Set a row to <b>bought</b> in the Cards table below to exclude it.
      </div>`;
  }

  function renderBinders() {
    const cols = liveCols();
    const cur = currentCol();

    $('#col-list').innerHTML = cols.map(c => {
      const v = C.valueOf(itemsIn(c.id), priceForKey);
      const rate = C.rateOf(c);
      const isTrade = c.kind === 'trade';
      return `<button class="binder" data-col="${esc(c.id)}" aria-selected="${c.id === S.curCol}">
        <span class="bn"><b>${esc(c.name)}${c.locked
            ? '<span class="lockicon" title="Permanent binder">🔒</span>' : ''}</b>
          <span>${(D.COLLECTION_KINDS[c.kind] || {}).label || c.kind} · ${v.cards} cards${
            isTrade && rate !== 100 ? ` · ${rate}% of market` : ''}</span></span>
        <span class="bv">${E.money(isTrade ? v.total * rate / 100 : v.total)}${
          isTrade && rate !== 100
            ? `<span class="small muted" style="display:block;font-weight:400">${E.money(v.total)} mkt</span>` : ''}</span>
      </button>`;
    }).join('')
    + (cur && cur.kind === 'trade' ? `
      <label class="fld" style="margin:12px 0 4px">
        <span>What this buyer pays, as % of market</span>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" id="trade-pct" min="10" max="100" step="5" value="${C.rateOf(cur)}">
          <b class="mono" id="trade-pct-v" style="min-width:44px;text-align:right">${C.rateOf(cur)}%</b>
        </div>
      </label>
      <div class="small muted" style="margin-bottom:8px">
        Vendors and traders rarely go 1:1. Set this per binder — a shop offering 60%
        and a friend trading at 90% can be separate binders.
      </div>` : '')
    + (cur && cur.locked
        ? `<div class="small muted" style="margin-top:8px;display:flex;gap:6px;align-items:center">
             <span style="opacity:.7">🔒</span>
             <span>This binder is permanent — keep and trade split drives the trade rate,
                   the supply signal scope and the "you already own this" check.</span>
           </div>`
        : cols.length > 1
          ? `<button class="btn ghost small" id="col-del" style="width:100%;margin-top:6px">Delete this binder</button>`
          : '');

    const pct = $('#trade-pct'), pctV = $('#trade-pct-v');
    if (pct) {
      // Live label while dragging, commit on release — otherwise every step
      // would rewrite the binder and schedule a sheet push.
      pct.addEventListener('input', () => { pctV.textContent = pct.value + '%'; });
      pct.addEventListener('change', () => {
        const c = currentCol();
        if (!c) return;
        c.tradePct = parseInt(pct.value, 10);
        c.updatedAt = Date.now();
        persistCollection();
        renderCollection();
      });
    }

    $$('#col-list .binder').forEach(b => b.addEventListener('click', () => {
      S.curCol = b.dataset.col; renderCollection();
    }));
    const del = $('#col-del');
    if (del) del.addEventListener('click', () => {
      const col = currentCol();
      // Belt and braces: the button is not rendered for locked binders, but a
      // delete path should never rely on the UI having hidden it.
      if (!col || col.locked) return;
      const n = itemsIn(col.id).length;
      if (!confirm(`Delete "${col.name}"${n ? ' and its ' + n + ' cards' : ''}?`)) return;
      col.deleted = 1; col.updatedAt = Date.now();
      for (const it of itemsIn(col.id)) { it.deleted = 1; it.updatedAt = Date.now(); }
      S.curCol = null;
      persistCollection();
      renderCollection();
    });
  }

  /* ---- tap-to-add grid --------------------------------------------------- */
  function renderAddGrid() {
    // Collections include everything you can own, not just what you can pull.
    const sets = browseSets();
    if (!S.addSet || !sets.some(s => s.id === S.addSet)) {
      const boosters = liveSets();
      S.addSet = boosters.length ? boosters[boosters.length - 1].id : (sets[0] && sets[0].id);
    }

    const sel = $('#add-set');
    if (sel.dataset.filled !== '1' || sel.value !== S.addSet) {
      const group = (label, list) => list.length
        ? `<optgroup label="${esc(label)}">` + list.map(s =>
            `<option value="${esc(s.id)}"${s.id === S.addSet ? ' selected' : ''}>${esc(s.short)} · ${esc(s.name)}</option>`
          ).join('') + '</optgroup>' : '';
      sel.innerHTML =
        group('Booster sets', sets.filter(s => s.kind === 'booster')) +
        group('Promos & event cards', sets.filter(s => s.kind === 'promo')) +
        group('Starter decks', sets.filter(s => s.kind === 'deck'));
      sel.dataset.filled = '1';
    }

    const col = currentCol();
    $('#add-target').textContent = col ? 'adding to ' + col.name : '';

    const min = Number($('#add-min').value) || 0;
    const q = S.addSearch.trim().toLowerCase();

    // Search spans every product; browsing shows the chosen one. A promo you
    // are hunting for is rarely filed where you would guess.
    let pool = q
      ? browseSets().reduce((acc, s) => acc.concat(browsePool(s.id)), [])
      : browsePool(S.addSet);
    pool = pool.filter(e => e.price >= min);
    if (q) pool = pool.filter(e =>
      e.card.card_name.toLowerCase().includes(q) || e.card.card_set_id.toLowerCase().includes(q));
    pool.sort((a, b) => b.price - a.price);
    if (q) {
      // A cross-product search can return thousands; the grid is a picker,
      // not a catalogue.
      pool = pool.slice(0, 200);
    }

    // In THIS binder = tap removes. In another binder = worth knowing, but the
    // tap still adds here. Conflating the two made the toggle unpredictable.
    const here = {}, elsewhere = {};
    for (const it of C.live(S.items)) {
      if (it.colId === (col && col.id)) here[it.key] = (here[it.key] || 0) + (Number(it.qty) || 0);
      else elsewhere[it.key] = true;
    }

    $('#add-grid').innerHTML = pool.slice(0, 120).map(e => {
      const n = here[e.key] || 0;
      const cls = n ? ' owned' : (elsewhere[e.key] ? ' elsewhere' : '');
      return `
      <div class="pick${cls}" data-key="${esc(e.key)}"
           title="${esc(e.card.card_name)}${n ? ' — in this binder, tap to remove' : elsewhere[e.key] ? ' — in another binder' : ''}">
        ${cardArt(e.card)}
        ${n > 1 ? `<span class="qtybadge">${n}</span>` : ''}
        <div class="pmeta"><span class="pp">${E.money(e.price)}</span>${rarityChip(e.card)}</div>
        <div class="pn">${esc(e.card.card_set_id)}</div>
      </div>`; }).join('') || `<div class="small muted">Nothing at that filter.</div>`;

    $$('#add-grid .pick').forEach(el => el.addEventListener('click', () => toggleCard(el.dataset.key)));
    fitGridRows('#add-grid', 3);
  }

  /**
   * Toggle, not increment. Tapping a card adds it once; tapping again removes
   * it. Quantity is edited in the table, deliberately — a mis-aimed tap on a
   * grid of 120 images should never silently inflate a count you cannot see.
   *
   * Only ever touches the plain raw row. A graded or condition-flagged copy of
   * the same card is a separate record and is left alone.
   */
  function toggleCard(key) {
    const col = currentCol();
    if (!col) return;
    const hit = C.live(S.items).find(it =>
      it.colId === col.id && it.key === key && !it.grader && it.cond === 'NM');

    if (hit) { hit.deleted = 1; hit.updatedAt = Date.now(); }
    else {
      // Promos, starter decks and event cards cannot be pulled from a pack, so
      // they must not default to "pulled" — that would credit a $3,499
      // Regionals card you bought as ripping profit in the scoreboard.
      S.items.push(C.newItem(col.id, key, { src: isPullable(key) ? 'pull' : 'buy' }));
    }

    persistCollection();
    renderCollection();
  }

  /* ---- the binder table -------------------------------------------------- */
  function renderColTable(col) {
    const tbody = $('#col-tbl tbody');
    if (!col) { tbody.innerHTML = ''; return; }

    const rows = itemsIn(col.id).slice().sort((a, b) => {
      const pa = priceForKey(a.key) || 0, pb = priceForKey(b.key) || 0;
      return (pb * (b.qty || 0)) - (pa * (a.qty || 0));
    });
    const v = C.valueOf(itemsIn(col.id), priceForKey);

    // Binders this card could move to. Deciding to sell something you kept is
    // routine, and the delete-and-re-add workaround destroyed seven fields —
    // including cost basis and the pulled/bought flag, which would have
    // recounted a bought card as a pull and inflated the rip scoreboard.
    const others = liveCols().filter(c => c.id !== col.id);

    const rate = C.rateOf(col);
    const traded = col.kind === 'trade' && rate !== 100;

    $('#col-title').textContent = col.name;
    $('#col-sub').innerHTML =
      `${v.cards} cards · ${traded ? '' : '<b>'}${E.money(v.total)}${traded ? ' market' : '</b>'}` +
      (traded ? ` · <b style="color:var(--brass)">${E.money(v.total * rate / 100)} at ${rate}%</b>` : '') +
      (v.unpriced ? ` · <span class="muted">${v.unpriced} unpriced</span>` : '');

    tbody.innerHTML = rows.map(it => {
      const card = S.byKey[it.key];
      const graded = C.isGraded(it);
      const manual = it.value != null && it.value !== '';
      // Graded copies have no feed, so they show an input until you value them.
      const each = manual ? Number(it.value) : (graded ? null : priceForKey(it.key));
      const qty = Number(it.qty) || 0;
      return `<tr data-id="${esc(it.id)}">
        <td><div class="cardcell">
          <img src="${esc(card ? card.card_image : '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="nm"><b>${esc(card ? card.card_name : it.key)}</b>
            <span>${esc(card ? card.card_set_id : '')}</span></div>
        </div></td>
        <td><span class="tag">${esc(card ? setShort(card.set_id) : '—')}</span></td>
        <td>
          <select class="it-grader" data-id="${esc(it.id)}" style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
            <option value="">Raw</option>
            ${D.GRADERS.map(g => `<option value="${g}"${it.grader === g ? ' selected' : ''}>${g}</option>`).join('')}
          </select>
          ${graded
            ? `<select class="it-grade" data-id="${esc(it.id)}" style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
                 ${[10,9.5,9,8.5,8,7,6,5,4,3,2,1].map(g =>
                   `<option value="${g}"${String(it.grade) === String(g) ? ' selected' : ''}>${g}</option>`).join('')}
               </select>`
            : `<select class="it-cond" data-id="${esc(it.id)}" style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
                 ${D.CONDITIONS.map(c => `<option value="${c.code}"${it.cond === c.code ? ' selected' : ''}>${c.code}</option>`).join('')}
               </select>`}
        </td>
        <td class="num"><input type="number" class="it-qty" data-id="${esc(it.id)}" min="0" step="1"
             value="${qty}" style="width:62px;text-align:right;padding:4px 6px;font-size:12px"></td>
        <td class="num">${graded || manual
            ? `<input type="number" class="it-value" data-id="${esc(it.id)}" min="0" step="0.01"
                 placeholder="${graded ? 'graded $' : 'market'}" value="${manual ? it.value : ''}"
                 style="width:88px;text-align:right;padding:4px 6px;font-size:12px"
                 title="${graded ? 'No free feed for graded prices — enter what it is worth' : 'Overrides the live market price'}">`
            : E.money(each)}</td>
        <td class="num"><input type="number" class="it-paid" data-id="${esc(it.id)}" min="0" step="0.01"
             placeholder="—" value="${it.paid == null ? '' : it.paid}"
             style="width:80px;text-align:right;padding:4px 6px;font-size:12px"
             title="What you paid, per copy"></td>
        <td class="num"><b>${each == null ? '—' : E.money(each * qty)}</b></td>
        <td class="num" style="white-space:nowrap">
          <select class="it-src" data-id="${esc(it.id)}" title="Pulled cards count as winnings in the scoreboard"
                  style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
            <option value="pull"${it.src !== 'buy' ? ' selected' : ''}>pulled</option>
            <option value="buy"${it.src === 'buy' ? ' selected' : ''}>bought</option>
          </select>
          ${others.length ? `
          <select class="it-move" data-id="${esc(it.id)}" title="Move to another binder, keeping everything"
                  style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
            <option value="">move…</option>
            ${others.map(o => `<option value="${esc(o.id)}">→ ${esc(o.name)}</option>`).join('')}
          </select>` : ''}
          <button class="btn ghost small it-del" data-id="${esc(it.id)}">×</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">
        No cards yet — tap one from the grid above.</td></tr>`;

    const find = id => S.items.find(x => x.id === id);
    const touch = it => { it.updatedAt = Date.now(); persistCollection(); renderCollection(); };

    /**
     * Bound what a number field will accept.
     *
     * Unbounded inputs let a held keypress turn a binder into $1.1bn, and a
     * negative cost basis makes the scoreboard's return meaningless. Values
     * are clamped rather than rejected so the edit is never silently lost.
     */
    const clamp = (raw, max) => {
      const n = parseFloat(raw);
      if (isNaN(n)) return null;
      return Math.min(Math.max(n, 0), max);
    };
    const MAX_QTY = 9999, MAX_MONEY = 1000000;

    $$('.it-qty').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      const n = clamp(el.value, MAX_QTY);
      if (n === null) { renderCollection(); return; }
      if (n === 0) { it.deleted = 1; } else { it.qty = Math.round(n); }
      touch(it);
    }));
    $$('.it-cond').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.cond = el.value; touch(it);
    }));
    $$('.it-grader').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.grader = el.value;
      // Graded copies have no market feed, so a fresh grade starts unpriced
      // and waits for you to enter what it is worth.
      it.grade = el.value ? (it.grade || 10) : '';
      touch(it);
    }));
    $$('.it-grade').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.grade = el.value; touch(it);
    }));
    $$('.it-paid').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.paid = clamp(el.value, MAX_MONEY); touch(it);
    }));
    $$('.it-value').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.value = clamp(el.value, MAX_MONEY); touch(it);
    }));
    $$('.it-src').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.src = el.value; touch(it);
    }));
    $$('.it-move').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id);
      const dest = el.value;
      if (!it || !dest) return;

      // If the destination already holds this exact card in the same state,
      // fold the quantities together instead of leaving two identical rows.
      const twin = C.live(S.items).find(x =>
        x.id !== it.id && x.colId === dest && x.key === it.key &&
        x.cond === it.cond && x.grader === it.grader &&
        String(x.grade) === String(it.grade) && x.src === it.src);

      if (twin) {
        twin.qty = (Number(twin.qty) || 0) + (Number(it.qty) || 0);
        // Keep a cost basis if only one side had one; sum when both do.
        if (it.paid != null) twin.paid = (twin.paid != null) ? twin.paid : it.paid;
        twin.updatedAt = Date.now();
        it.deleted = 1;
        it.updatedAt = Date.now();
      } else {
        it.colId = dest;
        it.updatedAt = Date.now();
      }
      persistCollection();
      renderCollection();
    }));
    $$('.it-del').forEach(el => el.addEventListener('click', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.deleted = 1; touch(it);
    }));
  }

  /* ---- persistence + sync ------------------------------------------------ */
  function persistCollection() {
    saveCritical(KEY.cols, S.cols);
    saveCritical(KEY.items, S.items);
    saveCritical(KEY.opens, S.opens);
    schedulePush();
  }

  function setSync(state, msg) {
    S.syncState = state; S.syncMsg = msg || '';
    const chip = $('#sync-chip');
    if (chip) chip.innerHTML =
      `<span class="sync-dot ${state === 'ok' ? 'on' : state === 'busy' ? 'busy' : state === 'err' ? 'err' : ''}"></span>
       <span>${esc(msg || (state === 'off' ? 'Sheets off' : state))}</span>`;
    const p = $('#sync-state');
    if (p) p.textContent = msg || state;
  }

  function schedulePush() {
    if (!S.syncUrl) return;
    clearTimeout(S.pushTimer);
    // Debounced: typing a quantity should not fire a write per keystroke.
    S.pushTimer = setTimeout(pushNow, 2500);
  }

  /**
   * Push only what changed.
   *
   * This used to send the ENTIRE collection on every debounced save, and the
   * Apps Script rewrote every row it already had. Editing one quantity in a
   * 200-card binder meant 200 sheet writes. Rows are now filtered to those
   * touched since the last confirmed push.
   */
  async function pushNow(force) {
    if (!S.syncUrl) return;

    // The manual "Save now" button forces a full resend — otherwise clicking it
    // when nothing is dirty would report "up to date" and look broken.
    const since = force ? 0 : (S.lastPushAt || 0);
    const dirty = rs => rs.filter(r => (r.updatedAt || 0) > since);
    const payload = {
      collections: dirty(S.cols),
      items: dirty(S.items),
      opens: dirty(S.opens)
    };
    const count = payload.collections.length + payload.items.length + payload.opens.length;
    if (!count) { setSync('ok', 'up to date'); return; }

    setSync('busy', `saving ${count}…`);
    // Stamped before the request: anything edited mid-flight keeps a newer
    // updatedAt and is caught by the next push rather than being skipped.
    const stamp = Date.now();
    try {
      await C.push(S.syncUrl, payload);
      S.lastPushAt = stamp;
      save(KEY.lastPush, stamp);
      setSync('ok', 'saved');
    } catch (err) {
      setSync('err', err.message);
    }
  }

  /**
   * Drop tombstones nobody needs any more.
   *
   * Deleted rows must linger or they resurrect from a device that has not
   * synced yet — but "not synced in three months" is not a scenario worth
   * carrying forever, and without this every deletion is permanent payload.
   */
  function compactTombstones() {
    const cutoff = Date.now() - 90 * 86400000;
    const keep = r => !r.deleted || (r.updatedAt || 0) > cutoff;
    const before = S.items.length + S.cols.length + S.opens.length;
    S.items = S.items.filter(keep);
    S.cols  = S.cols.filter(keep);
    S.opens = S.opens.filter(keep);
    const after = S.items.length + S.cols.length + S.opens.length;
    if (after !== before) {
      save(KEY.items, S.items); save(KEY.cols, S.cols); save(KEY.opens, S.opens);
    }
  }

  async function pullNow(silent) {
    if (!S.syncUrl) return;
    setSync('busy', 'loading…');
    try {
      const remote = await C.pull(S.syncUrl);
      S.cols  = C.mergeRows(S.cols, remote.collections);
      S.items = C.mergeRows(S.items, remote.items);
      S.opens = C.mergeRows(S.opens, remote.opens);
      save(KEY.cols, S.cols); save(KEY.items, S.items); save(KEY.opens, S.opens);
      setSync('ok', 'synced');
      if (!silent) renderCollection();
      else if (S.tab === 'collection') renderCollection();
    } catch (err) {
      setSync('err', err.message);
    }
  }

  function renderSyncPanel() {
    const body = $('#sync-panel');
    if (!body) return;
    body.innerHTML = `
      <div class="note small" style="margin-bottom:12px">
        Your collection saves to a Google Sheet you own, so it survives a cleared browser
        and follows you across devices. The repo is public, so the script URL is
        <b>not baked into the code</b> — paste it once per browser. Treat it like a
        password: anyone with the URL can read and write your sheet.
      </div>
      <label class="fld"><span>Apps Script /exec URL</span>
        <input type="text" id="sync-url" placeholder="https://script.google.com/macros/s/…/exec"
               value="${esc(S.syncUrl)}"></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn primary" id="sync-save">Connect</button>
        <button class="btn" id="sync-pull"${S.syncUrl ? '' : ' disabled'}>Load from Sheet</button>
        <button class="btn" id="sync-push"${S.syncUrl ? '' : ' disabled'}>Save now</button>
      </div>
      <div class="small muted" id="sync-state">${esc(S.syncMsg || S.syncState)}</div>
      <details class="adv" style="margin-top:12px">
        <summary>How to set the sheet up</summary>
        <div class="small muted" style="line-height:1.65;padding:4px 2px">
          1. New Google Sheet, leave it empty.<br>
          2. Extensions → Apps Script, paste in <code>apps-script.js</code> from this project, save.<br>
          3. Deploy → New deployment → Web app. Execute as <b>Me</b>, access <b>Anyone</b>.<br>
          4. Copy the <code>/exec</code> URL and paste it above.<br><br>
          "Anyone" is safe only because the URL is unguessable — treat it like a password.
          If it ever leaks, redeploy for a fresh one.
        </div>
      </details>`;

    $('#sync-save').addEventListener('click', async () => {
      const url = $('#sync-url').value.trim();
      if (url && !C.validUrl(url)) { setSync('err', 'Not a script.google.com URL'); return; }
      S.syncUrl = url; save(KEY.sync, url);
      if (!url) { setSync('off', 'Sheets off'); return; }
      // Pull first so connecting a populated sheet never clobbers it with an
      // empty local copy — merge is per row, so both sides survive.
      await pullNow(false);
      await pushNow(true);
      renderCollection();
    });
    $('#sync-pull').addEventListener('click', () => pullNow(false));
    $('#sync-push').addEventListener('click', () => pushNow(true));
  }

  /* =============================================================== SHELL == */

  function switchTab(tab) {
    S.tab = tab;
    $$('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== tab));
    renderActive();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Calls are the point of the Signals tab, and they need trend data. Making
    // that a button press meant the tab looked broken until you found it.
    // Scan once per session; the button stays for topping up after a filter change.
    if (tab === 'signals' && !S.sigAutoScanned) {
      S.sigAutoScanned = true;
      scanTrends(signalRows());
    }
  }

  /**
   * Renders are wrapped because a single bad card record should not blank the
   * whole tab with nothing but a console error the user will never open.
   * Failing visibly beats failing silently.
   */
  function renderActive() {
    const fns = {
      rip: renderRip, collection: renderCollection,
      sets: renderSets, signals: renderSignals, settings: renderSettings
    };
    const fn = fns[S.tab];
    if (!fn) return;
    try {
      fn();
    } catch (err) {
      const view = $(`.view[data-view="${S.tab}"]`);
      if (view) view.innerHTML = `
        <div class="panel"><div class="panel-b">
          <h3 style="margin:0 0 8px">This tab failed to render</h3>
          <p class="small muted">${esc(err && err.message ? err.message : String(err))}</p>
          <p class="small muted">Your collection is not affected. Refreshing the card data
             from Settings usually clears it.</p>
          <button class="btn primary" onclick="location.reload()">Reload</button>
        </div></div>`;
      if (window.console) console.error('[optcg-quant] render failed:', S.tab, err);
    }
  }

  function wire() {
    $$('#tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    $('#rip-set').addEventListener('change', e => {
      S.ripSet = e.target.value; S.ripCard = null; renderRip();
    });
    $('#rip-rarity').addEventListener('change', e => {
      S.ripRarity = e.target.value; S.ripCard = null; renderRip();
    });
    $('#rip-color').addEventListener('change', e => {
      S.ripColor = e.target.value; S.ripCard = null; renderRip();
    });
    // Debounced: each keystroke re-picks the top match, which is a different
    // card and therefore a different history lookup. No point chasing every
    // intermediate spelling of "shanks".
    let searchTimer = null;
    $('#rip-search').addEventListener('input', e => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.ripSearch = v; S.ripCard = null; renderRip();
      }, 180);
    });
    // ---- collection
    $('#col-new').addEventListener('click', () => {
      const name = prompt('Name this binder', 'New binder');
      if (!name) return;
      const kind = confirm('Is this trade / sell stock?\n\nOK = Trade / Sell, Cancel = Keeping')
        ? 'trade' : 'keep';
      const col = C.newCollection(name.trim(), kind);
      S.cols.push(col); S.curCol = col.id;
      persistCollection(); renderCollection();
    });
    $('#op-add').addEventListener('click', () => {
      const setId = $('#op-set').value;
      const boxes = Math.min(Math.max(parseInt($('#op-boxes').value, 10) || 0, 0), 999);
      const cost  = parseFloat($('#op-cost').value);
      if (!setId || boxes < 1) { alert('Enter how many boxes you opened (1–999).'); return; }
      if (isNaN(cost) || cost < 0 || cost > 1000000) {
        alert('Enter what you paid for those boxes.'); return;
      }
      S.opens.push(C.newOpen(setId, boxes, cost));
      $('#op-cost').value = '';
      persistCollection(); renderCollection();
    });
    $('#add-set').addEventListener('change', e => { S.addSet = e.target.value; renderAddGrid(); });
    $('#add-min').addEventListener('change', renderAddGrid);
    let addTimer = null;
    $('#add-search').addEventListener('input', e => {
      const v = e.target.value;
      clearTimeout(addTimer);
      addTimer = setTimeout(() => { S.addSearch = v; renderAddGrid(); }, 180);
    });

    $('#sig-min').addEventListener('change', renderSignals);
    $('#sig-set').addEventListener('change', renderSignals);
    $('#sig-scope').addEventListener('change', renderSignals);
    $('#sig-scan').addEventListener('click', () => scanTrends(signalRows()));

    $$('#sets-tbl th.sortable').forEach(th => th.addEventListener('click', () => {
      const by = th.dataset.sort;
      S.sort.sets = { by, dir: S.sort.sets.by === by ? -S.sort.sets.dir : -1 };
      renderSets();
    }));
    $$('#sig-tbl th.sortable').forEach(th => th.addEventListener('click', () => {
      const by = th.dataset.sort;
      S.sort.sig = { by, dir: S.sort.sig.by === by ? -S.sort.sig.dir : -1 };
      renderSignals();
    }));

    $('#pr-profile').addEventListener('change', renderSettings);
    $('#reset-boxes').addEventListener('click', () => {
      S.boxes = {}; save(KEY.boxes, S.boxes); renderSettings(); renderActive();
    });
    $('#reset-rates').addEventListener('click', () => {
      const v = $('#pr-profile').value || '';
      const id = v.slice(v.indexOf(':') + 1);
      if (v.indexOf('set:') === 0) { delete S.setRates[id]; save(KEY.setRates, S.setRates); }
      else                         { delete S.rates[id];    save(KEY.rates, S.rates); }
      $('#pr-profile').dataset.ready = '';
      invalidate(); renderSettings(); renderActive();
    });
    $('#clear-all').addEventListener('click', () => {
      // Deliberately does NOT touch the collection — losing a binder to a
      // settings-reset button would be unforgivable.
      if (!confirm('Reset box prices and pull rates to defaults?\n\nYour collection and cached card data are not touched.')) return;
      S.boxes = {}; S.rates = {}; S.setRates = {}; S.prefs = { friction: 100, advanced: false };
      [KEY.boxes, KEY.rates, KEY.setRates, KEY.prefs].forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
      $('#pr-profile').dataset.ready = '';
      invalidate(); renderSettings(); renderActive();
    });
    $('#refresh-data').addEventListener('click', async () => {
      const btn = $('#refresh-data');
      btn.disabled = true; btn.textContent = 'Refreshing…';
      try { await fetchCards(true); invalidate(); renderSettings(); renderActive(); }
      catch (err) { alert('Refresh failed: ' + err.message); }
      btn.disabled = false; btn.textContent = 'Refresh prices';
    });
    $('#retry').addEventListener('click', boot);
  }

  function fillSetPickers() {
    const opts = liveSets().map(s => `<option value="${esc(s.id)}">${esc(s.short)} · ${esc(s.name)}</option>`).join('');
    $('#sig-set').innerHTML = `<option value="all">All sets</option>` + opts;
  }

  /* A pending write must not die with the tab. sendBeacon survives unload where
     fetch does not. */
  function flushOnExit() {
    window.addEventListener('pagehide', () => {
      if (!S.syncUrl || !S.pushTimer) return;
      try {
        navigator.sendBeacon(S.syncUrl, new Blob(
          [JSON.stringify({ action: 'push', collections: S.cols, items: S.items })],
          { type: 'text/plain;charset=utf-8' }));
      } catch (_) {}
    });
  }

  /* ================================================================ BOOT == */

  async function boot() {
    $('#boot').classList.remove('hidden');
    $('#boot-error').classList.add('hidden');
    $('#app').classList.add('hidden');

    try {
      const r = await fetchCards(false);
      if (r.fromCache) {
        // Cache is warm — show it instantly, then quietly freshen in the background.
        fetchCards(true).then(() => { invalidate(); renderActive(); }).catch(() => {});
      }
      ensureCollections();
      compactTombstones();
      fillSetPickers();
      wire();
      flushOnExit();
      setSync(S.syncUrl ? 'ok' : 'off', S.syncUrl ? 'connected' : 'Sheets off');
      $('#boot').classList.add('hidden');
      $('#app').classList.remove('hidden');
      switchTab('rip');

      // Sheets is the source of truth across devices, so reconcile on every
      // load. Render first so a slow sheet never blocks the app.
      if (S.syncUrl) pullNow(true);
    } catch (err) {
      $('#boot').classList.add('hidden');
      $('#boot-error').classList.remove('hidden');
      $('#boot-error-msg').textContent = err.message;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})(OQ_DATA, OQ_ENGINE, OQ_COLLECTION);
