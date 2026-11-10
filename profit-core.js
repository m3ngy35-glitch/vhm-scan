// profit-core.js — VHMProfit shared profit calculation for VHM Scan (upload.html). Same copy as the one inside owner.html.
(function (root) {
  'use strict';

  const catalogCollection = 'sv2_profit_costs';
  const skuKey = value => String(value ?? '').trim().toLowerCase();

  function cents(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const amount = Number(String(value).trim().replace(/^\$\s*/, '').replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount < 0) return null;
    const rounded = Math.round((amount + Number.EPSILON) * 100);
    return Number.isSafeInteger(rounded) ? rounded : null;
  }

  function snapshotOperations(version, parent, rows) {
    const parts = [];
    for (let offset = 0; offset < rows.length; offset += 500) {
      parts.push({ col: catalogCollection, id: `${version}_${parts.length}`, data: { rows: rows.slice(offset, offset + 500) } });
    }
    return [...parts, { col: catalogCollection, id: version, data: { parent, parts: parts.length } }];
  }

  function catalogReader(read) {
    const cache = new Map();
    function load(version) {
      if (!cache.has(version)) cache.set(version, (async () => {
        const manifest = await read(catalogCollection, version);
        if (!manifest) return null;
        const parts = await Promise.all(Array.from({ length: manifest.parts }, (_, i) => read(catalogCollection, `${version}_${i}`)));
        if (parts.some(part => !part)) return null;
        const costs = new Map(parts.flatMap(part => part.rows.map(row => [skuKey(row.sku), row.costCents])));
        return { costs, parent: manifest.parent };
      })());
      return cache.get(version);
    }
    return async (version, sku) => {
      const key = skuKey(sku), seen = new Set();
      for (let current = version; current && !seen.has(current);) {
        seen.add(current);
        const snapshot = await load(current);
        if (!snapshot) return null;
        if (snapshot.costs.has(key)) return snapshot.costs.get(key);
        current = snapshot.parent;
      }
      return null;
    };
  }

  async function calculate(order, sessions, readCost) {
    const completed = sessions.filter(session => session.result === 'complete' || session.result === 'short');
    const latest = completed.sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')))[0];
    const packingStatus = order.st === 'c' ? 'Cancelled' : latest ? latest.result === 'short' ? 'Packed short' : 'Packed' : 'Waiting';
    const review = reason => ({ reason, packingStatus });
    if (order.st === 'c') return review('Cancelled');
    if (!latest) return review('Waiting for completed scan');
    if (latest.result === 'short') return review('Packed short');
    const evidence = latest.profitEvidence;
    if (!evidence) return review('Older scan has no SKU evidence');
    if (evidence.orderSig !== order.sig || evidence.revision !== (order.rev ?? 1)) return review('Order items changed after scanning');
    const finance = order.finance;
    const items = order.items || [];
    if (!finance || !Number.isSafeInteger(finance.amount) || !Number.isSafeInteger(finance.discount) || finance.discount > finance.amount || items.some(item => !Number.isSafeInteger(item.lineCents)) || items.reduce((sum, item) => sum + item.lineCents, 0) !== finance.amount) return review('Vrich merchandise or discount needs review');
    const scans = evidence.scans || [];
    const counts = items.map(() => 0);
    for (const scan of scans) {
      if (!Number.isInteger(scan.line) || !items[scan.line] || !scan.sku || !scan.version) return review('Scan has no verified PokPok SKU');
      counts[scan.line]++;
    }
    if (items.some((item, index) => counts[index] !== item.qty)) return review('Some items lack exact PokPok scan evidence');
    const groups = new Map();
    for (const scan of scans) {
      const key = JSON.stringify([scan.line, scan.sku, scan.version]);
      if (groups.has(key)) groups.get(key).quantity++;
      else groups.set(key, { ...scan, quantity: 1 });
    }
    const costLines = await Promise.all([...groups.values()].map(async item => ({ ...item, unitCostCents: await readCost(item.version, item.sku) })));
    if (costLines.some(item => !Number.isSafeInteger(item.unitCostCents) || item.unitCostCents <= 0)) return review('Missing landed cost for a scanned SKU');
    const cost = costLines.reduce((sum, item) => sum + item.unitCostCents * item.quantity, 0);
    const merchandise = finance.amount - finance.discount;
    return { merchandise, cost, grossProfit: merchandise - cost, costLines, packingStatus };
  }

  root.VHMProfit = { cents, skuKey, catalogCollection, snapshotOperations, catalogReader, calculate };
})(globalThis);
