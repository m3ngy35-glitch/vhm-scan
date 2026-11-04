// ============================================================================
// Copy Stock bookmarklet (staff click it on the Vrich Sale page) — source.
// Build the javascript: link with:  node tools/build-bookmarklet.js
//
// Part 1 (unchanged): sends the visible Sale-page lines to the staff member's
//   phone relay (vhm-catalog kv/stock_relay_<NAME>), exactly like before.
// Part 2 (new): builds a compact "sizes in stock" snapshot for VHM Inventory:
//   - every item on today's Sale page (all of them, not only the visible ones):
//     remain = quantity − ordered (an order counts at once, paid or not — the
//     piece is reserved for that customer)
//   - plus stock not added to the sale yet (/productStock/list, same login)
//   → { code: [[colour, size, remain], …] }, no cost, no price → gzip → saved to
//   vhm-catalog kv/vhm_sizes (+ a tiny kv/vhm_sizes_meta VHM Inventory checks).
//   Saved ONLY when the stock changed since this browser last saved it, and at
//   most every 2 minutes per browser → a few writes a day, not one per click.
// ============================================================================
(function () {
  var valid = ['KIN', 'JINH', 'YAA', 'RY', 'NITH', 'VID', 'LY', 'DAVID'];
  var name = localStorage.getItem('vhm_stock_name');
  if (!name || valid.indexOf(name.trim().toUpperCase()) === -1) {
    name = prompt('ឈ្មោះរបស់អ្នក? Type exactly one of: KIN, JINH, Yaa, Ry, NITH, VID, LY, David');
    if (!name || valid.indexOf(name.trim().toUpperCase()) === -1) { alert('Please use one of: KIN, JINH, Yaa, Ry, NITH, VID, LY, David'); return; }
    localStorage.setItem('vhm_stock_name', name);
  }
  var API = 'https://firestore.googleapis.com/v1/projects/vhm-catalog/databases/(default)/documents/kv/';
  var KEY = '?key=AIzaSyDDQp5_gvuRdX0flKQ3gm3zXJM_SXWUJSE';
  var key = 'stock_relay_' + name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  function toast(m, c, top) {
    var n = document.createElement('div'); n.textContent = m;
    n.style.cssText = 'position:fixed;top:' + (top || 16) + 'px;left:50%;transform:translateX(-50%);background:' + (c || '#1D9E75') + ';color:#fff;padding:10px 18px;border-radius:8px;font-size:15px;z-index:999999;font-family:sans-serif';
    document.body.appendChild(n); setTimeout(function () { n.remove(); }, 2200);
  }
  function save(doc, fields) { return fetch(API + doc + KEY, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: fields }) }); }

  // ---------- Part 1: phone relay (as before) ----------
  var lines = [];
  document.querySelectorAll('.monitor-item:not(.dummy)').forEach(function (li) {
    if (li.style.display === 'none' || li.getAttribute('hide') === '1') return;
    var code = li.querySelector('.code'), price = li.querySelector('.price'), qty = li.querySelector('.quantity'), remain = li.querySelector('.remain');
    if (!code || !remain) return;
    var line = [code.innerText, price ? price.innerText : '', qty ? qty.innerText : '', remain.innerText].join(' ');
    lines.push(line.replace(/\s+/g, ' ').trim());
  });
  save(key, { data: { stringValue: lines.join('\n') }, updatedAt: { timestampValue: new Date().toISOString() } })
    .then(function (r) { if (r.ok) toast('ផ្ញើទៅទូរស័ព្ទបានហើយ ✅ (' + lines.length + ')'); else toast('មិនបានជោគជ័យ ❌', '#E24B4A'); })
    .catch(function () { toast('មិនបានជោគជ័យ ❌', '#E24B4A'); });

  // ---------- Part 2: sizes snapshot for VHM Inventory ----------
  try { publishSizes(); } catch (e) { console.warn('VHM sizes', e); }

  function publishSizes() {
    var dEl = document.getElementById('search_date'), rEl = document.getElementById('search_round');
    if (!dEl) return;                                             // not the Sale page
    var now = new Date(), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var today = p2(now.getDate()) + '/' + p2(now.getMonth() + 1) + '/' + now.getFullYear();
    if (dEl.value !== today) return;                              // only today's sale is "now"
    if (rEl && rEl.selectedIndex !== rEl.options.length - 1) return;   // only the latest round
    var last = +localStorage.getItem('vhm_sizes_at') || 0;
    if (Date.now() - last < 2 * 60 * 1000) return;                // at most every 2 min per browser

    var SIZE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|F|FS|FREE|FREESIZE|\d{2})$/i;
    var map = {}, n = 0;
    function add(code, colour, size, qty, legacyBase) {
      code = String(code || '').replace(/!+$/, '').trim().toUpperCase(); if (!code) return;
      colour = String(colour || '').trim(); size = String(size || '').trim().toUpperCase();
      qty = Math.max(0, Math.round(+qty || 0));
      var arr = map[code] || (map[code] = []);
      for (var i = 0; i < arr.length; i++) if (arr[i][0] === colour && arr[i][1] === size) { arr[i][2] += qty; return; }
      var row = [colour, size, qty]; if (legacyBase) row.push(legacyBase); arr.push(row); n++;
    }
    // "អាវ ប៊ិច S" → colour ប៊ិច, size S · old pants "AA28" + "ខោ" → size 28 (base AA)
    function fromDesc(code, desc, qty) {
      var t = String(desc || '').trim().split(/\s+/).filter(Boolean), size = '', colour = '';
      if (t.length > 1 && SIZE.test(t[t.length - 1])) size = t.pop();
      if (t.length >= 2) colour = t[t.length - 1];
      var m = /^([A-Z]+)(\d{2})$/.exec(String(code).toUpperCase());
      if (!size && m && +m[2] >= 26 && +m[2] <= 46 && /^ខោ/.test(t[0] || '')) { add(code, colour, m[2], qty, m[1]); return; }
      add(code, colour, size, qty);
    }
    var $ = window.jQuery;
    document.querySelectorAll('.monitor-item:not(.dummy)').forEach(function (li) {
      var p = $ && $(li).data('product');
      var code = (p && p.code) || li.getAttribute('data-code');
      var desc = (p && p.description) || li.getAttribute('data-description');
      var q = +((p && p.quantity) != null ? p.quantity : li.getAttribute('data-quantity'));
      var ordered = +((p && p.details_count) != null ? p.details_count : li.getAttribute('data-details_count'));
      if (!code) return;
      if (isNaN(q) || isNaN(ordered)) {                           // fallback: the "sold / remain" text
        var m = /(-?[\d,]+)\s*$/.exec((li.querySelector('.remain') || {}).innerText || '');
        fromDesc(code, desc, m ? +m[1].replace(/,/g, '') : 0); return;
      }
      fromDesc(code, desc, q - ordered);
    });
    if (n < 300) return;                                          // the sale list isn't loaded yet — don't publish a partial one

    var url = '/productStock/list?date=' + encodeURIComponent(dEl.value) + '&round=' + encodeURIComponent(rEl ? rEl.value : '');
    fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
      .then(function (list) {
        list = Array.isArray(list) ? list : (list && (list.rows || list.data)) || [];
        list.forEach(function (s) {
          var code = s.sale_code || String(s.product_stock_code || '').split('-')[0];
          if (s.variant_size || s.variant_color) add(code, s.variant_color, s.variant_size, s.quantity);
          else fromDesc(code, s.product_stock_desc, s.quantity);
        });
        var codes = Object.keys(map).sort(), body = {};
        codes.forEach(function (c) { body[c] = map[c].sort(function (a, b) { return (a[0] + a[1]).localeCompare(b[0] + b[1]); }); });
        var json = JSON.stringify(body), h = 0;
        for (var i = 0; i < json.length; i++) h = (h * 31 + json.charCodeAt(i)) | 0;
        var hash = (h >>> 0).toString(36) + '-' + json.length;
        if (hash === localStorage.getItem('vhm_sizes_hash') && Date.now() - last < 30 * 60 * 1000) return;   // nothing changed
        return gzip64(json).then(function (z) {
          var at = new Date().toISOString(), meta = { hash: { stringValue: hash }, at: { timestampValue: at }, codes: { integerValue: String(codes.length) }, by: { stringValue: name.trim().toUpperCase() } };
          return save('vhm_sizes', Object.assign({ data: { stringValue: z } }, meta))
            .then(function (r) { if (!r.ok) throw new Error(r.status); return save('vhm_sizes_meta', meta); })
            .then(function (r) {
              if (!r.ok) throw new Error(r.status);
              localStorage.setItem('vhm_sizes_hash', hash); localStorage.setItem('vhm_sizes_at', String(Date.now()));
              toast('📏 VHM sizes updated (' + codes.length + ')', '#2563eb', 64);
              return saveDay(z, meta);
            });
        });
      }).catch(function (e) { console.warn('VHM sizes not saved', e); });
  }
  // Daily history for the VHM Inventory 📊 Dashboard: the FIRST snapshot of each day is
  // also kept as kv/vhm_sizes_day:<YYYY-MM-DD> (never overwritten: "only if it doesn't
  // exist yet"). Each browser tries once a day → about 1 write a day in total.
  function saveDay(z, meta) {
    var d = new Date(), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var day = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    if (localStorage.getItem('vhm_sizes_day') === day) return;
    var fields = Object.assign({ data: { stringValue: z }, day: { stringValue: day } }, meta);
    return fetch(API + 'vhm_sizes_day:' + day + KEY + '&currentDocument.exists=false', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: fields }) })
      .then(function (r) { if (r.ok || r.status === 400 || r.status === 409) localStorage.setItem('vhm_sizes_day', day); });
  }
  function gzip64(text) {
    var s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(s).arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf), out = '';
      for (var i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(out);
    });
  }
})();
