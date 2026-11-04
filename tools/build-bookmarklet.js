// node tools/build-bookmarklet.js  → writes tools/copy-stock-bookmarklet.txt (paste as the bookmark URL)
const fs = require("fs"), path = require("path");
let src = fs.readFileSync(path.join(__dirname, "copy-stock-bookmarklet.src.js"), "utf8");
src = src.split("\n").filter(l => !/^\s*\/\//.test(l)).map(l => l.replace(/\s+\/\/ [^'"]*$/, "").trim()).filter(Boolean).join("\n");
const out = "javascript:" + encodeURIComponent(src).replace(/%20/g, " ").replace(/%28/g, "(").replace(/%29/g, ")").replace(/%3B/g, ";").replace(/%2C/g, ",").replace(/%3D/g, "=");
fs.writeFileSync(path.join(__dirname, "copy-stock-bookmarklet.txt"), out);
console.log("bookmarklet length", out.length);

// ---- drag-and-drop install page: tools/install-copy-stock.html ----
const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const page = `<!doctype html>
<html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install Copy Stock</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1a1d23; --muted:#6b7280; --green:#1D9E75; --border:#e3e5e9; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1b1f25; --text:#e8eaed; --muted:#9aa0a6; --border:#2c313a; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 system-ui, -apple-system, "Noto Sans Khmer", sans-serif; }
  main { max-width:620px; margin:0 auto; padding:32px 16px; }
  h1 { font-size:24px; margin:0 0 4px; }
  .muted { color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px; margin:18px 0; }
  .drag { display:inline-block; background:var(--green); color:#fff; font-weight:700; font-size:20px; padding:14px 26px; border-radius:10px; text-decoration:none; cursor:grab; box-shadow:0 2px 8px rgba(0,0,0,.15); }
  .drag:active { cursor:grabbing; }
  ol { padding-left:22px; margin:8px 0 0; } li { margin:6px 0; }
  kbd { background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:0 6px; font-size:14px; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; }
</style></head><body><main>
  <h1>📋 Copy Stock</h1>
  <p class="muted">Sends stock to your phone (Quick Reply, Live Log) — same as before — and keeps the sizes in VHM Inventory up to date.<br>ផ្ញើស្តុកទៅទូរស័ព្ទ ដូចមុន ហើយធ្វើបច្ចុប្បន្នភាពទំហំនៅក្នុង VHM Inventory។</p>

  <div class="card" style="text-align:center">
    <a class="drag" href="${esc(out)}" title="Drag me to the bookmarks bar" onclick="alert('Drag this button to the bookmarks bar · អូសប៊ូតុងនេះទៅរបារ Bookmarks'); return false;">📋 Copy Stock</a>
    <p class="muted" style="margin:12px 0 0">⬆ Drag this button up to the bookmarks bar · អូសប៊ូតុងនេះឡើងទៅរបារ Bookmarks</p>
  </div>

  <div class="card">
    <b>How to install · របៀបដំឡើង</b>
    <ol>
      <li>Bookmarks bar not showing? Press <kbd>⌘ Cmd</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> (Windows: <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>). · មិនឃើញរបារ Bookmarks? ចុច Cmd+Shift+B</li>
      <li>Drag the green <b>📋 Copy Stock</b> button onto the bookmarks bar. · អូសប៊ូតុងពណ៌បៃតងទៅរបារ</li>
      <li>Right-click the <b>old</b> Copy Stock bookmark → <b>Delete</b>, so there is only one. · លុប Copy Stock ចាស់ចោល</li>
      <li>Use it exactly as before on the Vrich Sale page. Your name is remembered. · ប្រើដូចមុននៅទំព័រ Sale របស់ Vrich</li>
    </ol>
  </div>

  <div class="card">
    <b>Can't drag? · អូសមិនបាន?</b>
    <p class="muted" style="margin:6px 0 10px">Copy the code, then right-click the old Copy Stock bookmark → Edit → paste it into URL.<br>ចម្លងកូដ → ចុចស្តាំលើ Copy Stock ចាស់ → Edit → បិទភ្ជាប់ក្នុង URL</p>
    <button id="copy">📄 Copy code · ចម្លងកូដ</button> <span id="ok" class="muted"></span>
  </div>
</main>
<script>
  document.getElementById("copy").onclick = function () {
    var t = document.querySelector(".drag").getAttribute("href");
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { document.getElementById("ok").textContent = "✓ Copied · បានចម្លង"; })
      .catch(function () { prompt("Copy this · ចម្លង", t); });
  };
</script>
</body></html>`;
fs.writeFileSync(path.join(__dirname, "install-copy-stock.html"), page);
console.log("install page written");
