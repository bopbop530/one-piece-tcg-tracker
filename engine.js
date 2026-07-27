/* ============================================================================
   OPTCG QUANT — engine.js
   All the math. No DOM access in this file.
   ========================================================================== */

const OQ_ENGINE = (function (D) {
  'use strict';

  /* ==========================================================================
     1. CARD CLASSIFICATION
     ========================================================================== */

  /**
   * Pull the variant markers out of a card name.
   * Only exact whitelisted tags count — "(Galdino)" and "(001)" are not variants.
   */
  function parseVariants(cardName) {
    const found = [];
    const re = /\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(cardName)) !== null) {
      const tag = m[1].trim();
      if (Object.prototype.hasOwnProperty.call(D.VARIANT_TAGS, tag)) found.push(tag);
    }
    return found;
  }

  /**
   * Decide which pull slot a card occupies.
   * Highest-ranked variant wins: "Shanks (Parallel) (Manga) (Alternate Art)"
   * is a Manga Rare, not a Parallel.
   * Returns null for anything that cannot come out of a sealed pack.
   */
  function classify(card) {
    const tags = parseVariants(card.card_name);
    const isPromo = card.rarity === 'PR';

    // DON!! cards arrive from a separate endpoint already marked pullable or
    // not — most ship in Double Pack Sets and promos rather than boosters.
    if (card.rarity === 'DON') {
      if (!card.donBooster) {
        return { slot: null, reason: card.donProduct || 'Not a booster DON!!', tags };
      }
      // Gold and Silver DON!! are a separate printing, not a lucky draw from
      // the ordinary pool. In PRB-01 the Gold ones average $131 against $1.98
      // for plain — treating them as one slot made the average meaningless.
      const premium = /\((?:Gold|Silver)\)/.test(card.card_name);
      return { slot: premium ? 'DONGOLD' : 'DON',
               variantLabel: card.donVariant || 'DON!!', tags };
    }

    let best = null;
    for (const tag of tags) {
      const def = D.VARIANT_TAGS[tag];
      if (!def || !def.slot) continue;
      if (def.slot === 'EXCLUDE') return { slot: null, reason: def.label, tags };
      if (!best || def.rank > D.VARIANT_TAGS[best].rank) best = tag;
    }

    if (isPromo) return { slot: null, reason: 'Promo', tags };

    if (best) {
      return { slot: D.VARIANT_TAGS[best].slot, variantLabel: D.VARIANT_TAGS[best].label, tags };
    }
    // No variant marker — it sits in its printed base rarity slot.
    if (Object.prototype.hasOwnProperty.call(D.RARITY, card.rarity)) {
      return { slot: card.rarity, variantLabel: null, tags };
    }
    return { slot: null, reason: 'Unknown rarity ' + card.rarity, tags };
  }

  /**
   * What the card actually shows in its bottom-right corner, plus which
   * physical treatment it carries.
   *
   * `text` is the PRINTED rarity, which is not the same as the chase tier —
   * "Kuzan (Manga)" is stamped R and sells for $1,060. `tone` is the treatment
   * that makes it valuable and drives the colour. `star` mirrors the real card:
   * parallels and alternate arts print a ★ above the rarity letter.
   */
  function rarityBadge(card) {
    const cls = classify(card);
    const tags = cls.tags || [];
    const has = t => tags.indexOf(t) > -1;

    if (card.rarity === 'DON') {
      const gold = /\(Gold\)/.test(card.card_name);
      const silver = /\(Silver\)/.test(card.card_name);
      return {
        text: 'DON', star: /Alternate Art|Manga/.test(card.card_name),
        tone: gold ? 'GOLD' : silver ? 'SILVER' : 'DON',
        label: cls.variantLabel || 'DON!!'
      };
    }

    let tone = card.rarity || 'C';
    if (cls.slot === 'MANGA')      tone = 'MANGA';
    else if (cls.slot === 'SP')    tone = 'SP';
    else if (cls.slot === 'TR')    tone = 'TR';
    else if (cls.slot === 'ULTRA') tone = has('Silver') ? 'SILVER' : 'GOLD';

    // SP and TR are printed designations in their own right — an SP card is
    // stamped SP, not the base rarity it was reprinted from. Everything else
    // shows the base letter, because that IS what the corner says.
    let text = card.rarity || '?';
    if (has('SP') || has('SPR')) text = 'SP';
    else if (has('TR'))          text = 'TR';

    // The ★ marks an alternate-art treatment. Manga Rares and the Super Alt /
    // Gold / Silver tier are alternate arts too, so they carry it — only the
    // plain base printings and SP's own designation go without.
    const star = cls.slot === 'ALT' || cls.slot === 'MANGA' || cls.slot === 'ULTRA';

    return {
      text: text,
      star: star,
      tone: tone,
      label: cls.variantLabel || (D.RARITY[card.rarity] || {}).label || card.rarity
    };
  }

  /**
   * Stable unique key.
   *
   * Neither id field is unique on its own, and this bites hard:
   *   card_set_id   — 723 collisions (a card and its Box Topper share one)
   *   card_image_id —  41 collisions (OP07-076 is a $0.25 common in OP-07,
   *                    a $1.69 Pirate Foil in PRB-02, AND a $0.30 reprint)
   *   set + image   —  28 collisions (Jolly Roger Foil vs Alternate Art)
   *
   * set + image + name leaves exactly one collision across all 3,485 cards,
   * and that one is a genuine duplicate row in the source data — two identical
   * Gecko Moria entries at the same price — so collapsing it is harmless.
   *
   * Anything less than this and clicking an expensive variant silently
   * resolves to the cheap card that shares its id.
   */
  function cardKey(card) {
    return card.set_id + '|' + (card.card_image_id || card.card_set_id) + '|' + card.card_name;
  }

  /* ==========================================================================
     2. SET INDEXING
     ========================================================================== */

  /**
   * Group one set's cards into pull slots and compute per-slot averages.
   * `priceOf` lets the caller swap in region overrides.
   */
  function buildSetIndex(setId, cards, priceOf) {
    const pools = {};
    const excluded = [];

    for (const card of cards) {
      const cls = classify(card);
      if (!cls.slot) { excluded.push({ card, reason: cls.reason }); continue; }
      (pools[cls.slot] = pools[cls.slot] || []).push({
        card,
        key: cardKey(card),
        slot: cls.slot,
        variantLabel: cls.variantLabel,
        price: priceOf(card)
      });
    }

    const slots = {};
    const all = [];
    for (const key of Object.keys(pools)) {
      const entries = pools[key];
      const total = entries.reduce((s, e) => s + e.price, 0);
      entries.sort((a, b) => b.price - a.price);
      slots[key] = {
        key,
        entries,
        count: entries.length,
        avgPrice: entries.length ? total / entries.length : 0,
        maxPrice: entries.length ? entries[0].price : 0
      };
      for (const e of entries) all.push(e);
    }
    // Flat, pre-sorted view of every pullable card in the set. Callers used to
    // rebuild this by walking every slot on every render — the Signals tab did
    // it across all 21 sets each time a filter changed.
    all.sort((a, b) => b.price - a.price);
    return { setId, slots, all, excluded, cards };
  }

  /* ==========================================================================
     3. EXPECTED VALUE
     ========================================================================== */

  /**
   * EV of a sealed box = sum over slots of (expected copies per box) x
   * (average market price of that slot's pool).
   *
   * Uniform-within-slot is an assumption, not a fact — Bandai does not publish
   * per-card weighting. It is the standard approach and it is what makes the
   * "chase concentration" number worth reading: the more the slot's value sits
   * in one card, the more the average lies to you.
   */
  function evaluate(index, config) {
    const perBox = config.perBox;
    const breakdown = [];
    let evBox = 0;

    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const expected = perBox[key] || 0;
      const pool = index.slots[key];
      if (!expected || !pool || !pool.count) continue;
      const value = expected * pool.avgPrice;
      evBox += value;
      breakdown.push({
        key, label: slotDef.label,
        expectedPerBox: expected,
        poolSize: pool.count,
        avgPrice: pool.avgPrice,
        maxPrice: pool.maxPrice,
        value,
        // How top-heavy this slot is: 1.0 means one card carries the whole slot.
        concentration: pool.avgPrice > 0 ? pool.maxPrice / (pool.avgPrice * pool.count) : 0
      });
    }

    breakdown.sort((a, b) => b.value - a.value);
    const packs = config.packsPerBox || 24;
    return {
      evBox,
      evPack: evBox / packs,
      packsPerBox: packs,
      breakdown,
      // Share of total box EV coming from the single most valuable slot.
      topSlotShare: evBox > 0 && breakdown.length ? breakdown[0].value / evBox : 0
    };
  }

  /**
   * Does this pull-rate config actually describe this set's card pool?
   *
   * Catches the failure mode where a slot is assigned copies per box but the
   * set has no such cards (or only a handful), which silently redistributes
   * value and produces confident nonsense. Cheap insurance against every
   * future set that ships with a structure nobody documented.
   */
  function configFit(index, config) {
    const issues = [];
    let counted = 0;

    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const expected = config.perBox[key] || 0;
      counted += expected;
      const pool = index.slots[key];
      // Only a material rate matters. Plenty of sets legitimately have no
      // Manga or Gold cards at all; a 0.01/box rate against an empty pool
      // contributes nothing and is not a problem worth shouting about.
      // Threshold of 5, not 1. A slot claiming five or more cards a box that
      // the set does not contain means the config describes the wrong product
      // — that is how the Extra Booster mismatch (72 uncommons per box, set
      // has none) surfaced. One missing DON!! is a gap in the source data, not
      // a broken structure, and evaluate() already ignores empty pools.
      if (expected >= 5 && (!pool || !pool.count)) {
        issues.push({
          severity: 'error', slot: key,
          message: `Config expects ${expected} ${slotDef.label} per box, but this set has none — the structure does not match this product.`
        });
      } else if (expected === 0 && pool && pool.count) {
        // The inverse mistake, and the one that hid a bug: the set HAS these
        // cards but the rate says zero, so the app reports them as impossible
        // to pull and drops their value from EV entirely. Silent until you
        // click one and it tells you the card cannot exist.
        issues.push({
          severity: 'error', slot: key,
          message: `This set has ${pool.count} ${slotDef.label} card${pool.count === 1 ? '' : 's'}, but your rate is 0 per box — they are treated as impossible to pull.`
        });
      } else if (expected >= 1 && pool && pool.count < 3) {
        issues.push({
          severity: 'warn', slot: key,
          message: `Only ${pool.count} ${slotDef.label} card${pool.count === 1 ? '' : 's'} in the pool — the average is one card.`
        });
      }
    }

    const capacity = (config.packsPerBox || 24) * (config.cardsPerPack || 12);
    const drift = counted - capacity;
    if (Math.abs(drift) > 1) {
      issues.push({
        severity: 'error', slot: null,
        message: `Slots total ${counted.toFixed(2)} cards but the box holds ${capacity}.`
      });
    }
    return { issues, counted, capacity, ok: !issues.some(i => i.severity === 'error') };
  }

  /**
   * Chase concentration across the whole set: what fraction of total box EV is
   * carried by the top N cards. High = lottery ticket, low = grindy value set.
   */
  function chaseConcentration(index, config, topN) {
    topN = topN || 5;
    const contributions = [];
    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const expected = config.perBox[key] || 0;
      const pool = index.slots[key];
      if (!expected || !pool || !pool.count) continue;
      // Each card in the slot is equally likely, so each contributes
      // (expected / poolSize) copies per box.
      const copiesEach = expected / pool.count;
      for (const e of pool.entries) {
        contributions.push({ entry: e, value: copiesEach * e.price });
      }
    }
    contributions.sort((a, b) => b.value - a.value);
    const total = contributions.reduce((s, c) => s + c.value, 0);
    const top = contributions.slice(0, topN);
    const topValue = top.reduce((s, c) => s + c.value, 0);
    return {
      total,
      top,
      share: total > 0 ? topValue / total : 0,
      all: contributions
    };
  }

  /* ==========================================================================
     4. RIP vs BUY
     ========================================================================== */

  /**
   * Per-pack probability of pulling one specific card.
   * Assumes uniform distribution inside the card's slot.
   */
  function perPackProbability(index, config, targetKey) {
    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const pool = index.slots[key];
      if (!pool) continue;
      const hit = pool.entries.find(e => e.key === targetKey);
      if (!hit) continue;
      const expectedPerBox = config.perBox[key] || 0;
      if (!expectedPerBox) return { p: 0, slot: key, poolSize: pool.count, entry: hit, impossible: true };
      const packs = config.packsPerBox || 24;
      const copiesPerBox = expectedPerBox / pool.count;
      return {
        p: copiesPerBox / packs,
        slot: key,
        poolSize: pool.count,
        expectedPerBox,
        copiesPerBox,
        entry: hit,
        impossible: false
      };
    }
    return null;
  }

  /**
   * The core question: is chasing this card cheaper than just buying it?
   *
   * The honest version has to credit the value of everything ELSE you open.
   * Ripping N packs costs N x packPrice but returns N x evPack in other cards,
   * so the true cost of the chase is N x (packPrice - evPack).
   */
  function ripVsBuy(opts) {
    const { p, packPrice, evPack, singlePrice, sellFriction } = opts;
    if (!p || p <= 0) return null;

    const friction = sellFriction == null ? 0.15 : sellFriction;
    // What you actually realise selling the rest of the pulls, after fees/shipping.
    const realisedPerPack = evPack * (1 - friction);
    const netPerPack = packPrice - realisedPerPack;

    const expectedPacks = 1 / p;
    const packsFor = q => Math.log(1 - q) / Math.log(1 - p);

    // A card that costs less than a couple of packs is not a chase, whatever
    // the expected value says. Telling someone to rip a case for a $3 single
    // is technically defensible and practically useless.
    const trivial = singlePrice > 0 && singlePrice < packPrice * 2;

    const grossCost = expectedPacks * packPrice;
    const netCost = expectedPacks * netPerPack;

    return {
      p,
      expectedPacks,
      expectedBoxes: expectedPacks / (opts.packsPerBox || 24),
      packs50: packsFor(0.5),
      packs90: packsFor(0.9),
      pPerBox: 1 - Math.pow(1 - p, opts.packsPerBox || 24),
      grossCost,
      netCost,
      realisedPerPack,
      netPerPack,
      singlePrice,
      // Negative edge means ripping is the cheaper route to the card.
      edge: netCost - singlePrice,
      edgePct: singlePrice > 0 ? (netCost - singlePrice) / singlePrice : null,
      trivial,

      // Two honest ways to read the same chase, for two different people.
      //
      // simpleVerdict compares what you would SPEND on product against the
      // single's price. That is the right lens for a collector who keeps what
      // they open — the other cards are not income, they are more collection.
      //
      // netVerdict credits the resale value of everything else you pull. That
      // is the right lens only if you actually sell it.
      //
      // Chasing one specific card almost always loses on the simple lens, and
      // that is not a bug — it is the answer that saves money.
      simpleVerdict: trivial ? 'TRIVIAL' : (grossCost < singlePrice ? 'RIP' : 'BUY'),
      netVerdict:    trivial ? 'TRIVIAL' : (netCost   < singlePrice ? 'RIP' : 'BUY'),
      grossEdge: grossCost - singlePrice,

      // If netPerPack <= 0 the packs pay for themselves; the chase is free.
      freeRoll: netPerPack <= 0
    };
  }

  /* ==========================================================================
     5. SUPPLY / DEMAND SIGNAL

     There is no free eBay listing-count or PSA population feed, so TCGQuant's
     literal inputs are not reproducible. What IS available on every card is
     both a lowest-listing price and a recent-sold market price.

     The gap between them is a real supply signal:
       - inventory well BELOW market  -> plenty of cheap listings, soft supply
       - inventory pushing UP TO market -> cheap copies drying up, tightening
     ========================================================================== */

  function spreadSignal(entryOrCard) {
    const c = entryOrCard.card || entryOrCard;
    const inv = c.inventory_price;
    const mkt = c.market_price;
    if (!mkt || mkt <= 0 || inv == null || inv <= 0) return null;

    const ratio = inv / mkt;               // 1.0 = floor has met the market
    const discount = 1 - ratio;            // how far below market you can buy

    let state, score;
    if (ratio >= 0.95)      { state = 'TIGHT';   score = 9; }
    else if (ratio >= 0.85) { state = 'FIRMING'; score = 7; }
    else if (ratio >= 0.70) { state = 'NORMAL';  score = 5; }
    else if (ratio >= 0.50) { state = 'SOFT';    score = 3; }
    else                    { state = 'LOOSE';   score = 1; }

    return { ratio, discount, state, score, inventory: inv, market: mkt };
  }

  /**
   * Mechanical action flag. Not advice — a rule you can read and disagree with.
   *
   * Two independent facts have to agree before anything is flagged:
   *   supply   — is the listing floor closing on the market price
   *   momentum — is the 13-day price actually moving
   *
   * Supply alone is not enough. A floor above market can mean a card is running,
   * or it can mean one stale overpriced listing on a card nobody has touched in
   * six months. Requiring momentum to confirm kills most of that noise, and
   * anything scraped more than STALE_DAYS ago is refused outright rather than
   * dressed up as a signal.
   */
  const STALE_DAYS = 30;

  function actionTag(o) {
    const sig = o.sig, age = o.age, h = o.hist;

    if (age != null && age > STALE_DAYS) {
      return { code: 'STALE', label: 'STALE',
               why: `Last priced ${age} days ago — no read worth trusting.` };
    }

    const tight = sig && sig.ratio >= 0.85;
    const loose = sig && sig.ratio < 0.70;

    // A frozen series carries no momentum information — treating 13 repeats of
    // one number as "price is flat" would confidently mislabel a card nobody
    // has repriced in months.
    if (h && h.frozen) {
      return { code: 'STALE', label: 'NO TREND',
               why: 'Price has not moved for 13 straight days — almost certainly not repriced rather than genuinely stable.' };
    }

    if (!h) {
      if (tight) return { code: 'WATCH', label: 'WATCH',
                          why: 'Cheap copies thinning out. Scan trends to confirm it is moving.' };
      return null;
    }

    const rising  = h.changePct >  0.03;
    const falling = h.changePct < -0.03;
    const move = (h.changePct >= 0 ? '+' : '') + (h.changePct * 100).toFixed(1) + '% in 13 days';

    if (o.ownedTrade && loose && falling) {
      return { code: 'TRIM', label: 'TRIM',
               why: `You hold this to sell. Plenty of cheap copies and ${move} — the exit is closing.` };
    }
    if (o.owned && tight && rising) {
      return { code: 'HOLD', label: 'HOLD',
               why: `You own it, cheap copies are drying up and it is ${move}. Not the moment to sell.` };
    }
    if (!o.owned && tight && rising) {
      return { code: 'BUY', label: 'MUST BUY',
               why: `Floor at ${Math.round(sig.ratio * 100)}% of market and ${move}. Supply tightening while the price moves.` };
    }
    if (tight)  return { code: 'WATCH', label: 'WATCH',
                         why: `Supply tightening but price is flat (${move}).` };
    if (loose && falling) return { code: 'AVOID', label: 'SOFT',
                         why: `Cheap copies everywhere and ${move}.` };
    return null;
  }

  /** Days since this card's price was last scraped. Stale data lies. */
  function staleness(card, today) {
    if (!card.date_scraped) return null;
    const then = new Date(card.date_scraped + 'T00:00:00');
    const now = today ? new Date(today) : new Date();
    if (isNaN(then.getTime())) return null;
    return Math.round((now - then) / 86400000);
  }

  /* ==========================================================================
     6. PRICE HISTORY (13-day window from the twoweeks endpoint)
     ========================================================================== */

  function parseHistory(row) {
    const series = [];
    for (let i = 13; i >= 1; i--) {
      const v = row['Day' + i + '_Market_Price'];
      if (typeof v === 'number' && v > 0) series.push(v);
    }
    if (typeof row.market_price === 'number' && row.market_price > 0) series.push(row.market_price);
    if (series.length < 2) return null;

    const first = series[0];
    const last = series[series.length - 1];
    const mean = series.reduce((s, v) => s + v, 0) / series.length;
    const variance = series.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / series.length;

    // Every value identical across 13 days does NOT mean a stable price — for
    // cards nobody has rescraped, the endpoint simply replays the last known
    // figure (a 392-day-old SPR returns the same number thirteen times).
    // Flat and frozen look the same in the data and mean opposite things, so
    // they must not be reported as "no movement".
    const frozen = series.every(v => v === first);

    return {
      series,
      first, last, frozen,
      change: last - first,
      changePct: first > 0 ? (last - first) / first : 0,
      min: Math.min.apply(null, series),
      max: Math.max.apply(null, series),
      volatility: mean > 0 ? Math.sqrt(variance) / mean : 0
    };
  }

  /* ==========================================================================
     7. HELPERS
     ========================================================================== */

  function money(n, dp) {
    if (n == null || isNaN(n)) return '—';
    const d = dp == null ? (Math.abs(n) >= 100 ? 0 : 2) : dp;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function pct(n, dp) {
    if (n == null || isNaN(n)) return '—';
    return (n * 100).toFixed(dp == null ? 1 : dp) + '%';
  }

  /** "1 in 340 packs" reads better than "0.29%" when the number is tiny. */
  function odds(p) {
    if (!p || p <= 0) return '—';
    const one = 1 / p;
    if (one < 2) return (p * 100).toFixed(1) + '% per pack';
    return '1 in ' + (one < 20 ? one.toFixed(1) : Math.round(one).toLocaleString()) + ' packs';
  }

  return {
    parseVariants, classify, cardKey, rarityBadge,
    buildSetIndex, evaluate, chaseConcentration, configFit,
    perPackProbability, ripVsBuy,
    spreadSignal, staleness, parseHistory, actionTag, STALE_DAYS,
    money, pct, odds
  };
})(OQ_DATA);
