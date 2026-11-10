// ODDKULT admin panel (kept in its own file so the page can use a strict Content-Security-Policy)
    const $ = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];
    const tk = (n) => "৳" + Number(n || 0).toLocaleString("en-IN");
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const imgUrl = (id, sm) => (!id ? "" : id.startsWith("u/") ? `/img/${id}` : id.includes(".") ? `/img/products/${id}` : `/img/products/${id}${sm ? "-sm" : ""}.webp`);
    const STATUSES = ["new", "confirmed", "shipped", "delivered", "cancelled", "returned"];
    let KEY = "";
    try { KEY = sessionStorage.getItem("ok-admin") || ""; } catch {}
    let ORDERS = [], COLUMNS = [], PRODUCTS = [], COLLECTIONS = [], SETTINGS = {}, TAB = "orders";

    let toastT;
    function toast(msg, bad) {
      const t = $("#toast"); t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
      clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), bad ? 5000 : 2200);
    }
    async function api(path, opts = {}) {
      const res = await fetch(path, { ...opts, headers: { "x-admin-key": KEY, ...(opts.body && !(opts.body instanceof Blob) ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } });
      if (res.status === 401) { logout("Wrong password."); throw new Error("Wrong password"); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      return data;
    }

    /* ---------------- login / tabs ---------------- */
    function logout(msg) {
      KEY = ""; try { sessionStorage.removeItem("ok-admin"); } catch {}
      $("#app").hidden = true; $("#login").hidden = false; $("#lerr").textContent = msg || "";
    }
    async function start() {
      await loadOrders();
      $("#login").hidden = true; $("#app").hidden = false;
      loadProducts().catch(() => {});
      loadSettings().catch(() => {});
    }
    $("#go").onclick = () => { KEY = $("#key").value.trim(); try { sessionStorage.setItem("ok-admin", KEY); } catch {} start().catch((e) => ($("#lerr").textContent = e.message)); };
    $("#showkey").addEventListener("change", (e) => { $("#key").type = e.target.checked ? "text" : "password"; });
    $("#key").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#go").click(); });
    $("#logout").onclick = () => logout();
    $("#tabs").onclick = (e) => {
      const b = e.target.closest("button[data-tab]"); if (!b) return;
      TAB = b.dataset.tab;
      $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
      $$("main[data-view]").forEach((m) => (m.hidden = m.dataset.view !== TAB));
      if (TAB === "categories") renderCats();
    };

    /* ---------------- orders ---------------- */
    async function loadOrders() {
      const data = await api(`/api/orders`);
      ORDERS = data.orders; COLUMNS = data.columns;
      $("#csvurl").textContent = `${location.origin}/api/orders.csv?key=${encodeURIComponent(KEY)}`;
      renderOrders();
    }
    const waLink = (o) => {
      const msg = `Hi ${o.name}, this is ODDKULT. We received your order ${o.id}: ${o.items_summary}. Total ${tk(o.total)} (cash on delivery) to ${o.address}, ${o.district}. Please reply YES to confirm.`;
      return `https://wa.me/88${o.phone}?text=${encodeURIComponent(msg)}`;
    };
    function renderOrders() {
      const q = $("#q").value.trim().toLowerCase();
      const st = $("#filter").value;
      const list = ORDERS.filter((o) => (!st || o.status === st) && (!q || [o.id, o.name, o.phone, o.items_summary, o.address, o.district].join(" ").toLowerCase().includes(q)));
      const live = ORDERS.filter((o) => !["cancelled", "returned"].includes(o.status));
      const today = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
      const newN = ORDERS.filter((o) => o.status === "new").length;
      $("#newCount").hidden = !newN; $("#newCount").textContent = newN;
      $("#stats").innerHTML = [
        ["New, to confirm", newN, newN ? "alert" : ""],
        ["Orders today", ORDERS.filter((o) => (o.created_bd || "").startsWith(today)).length],
        ["To ship", ORDERS.filter((o) => o.status === "confirmed").length],
        ["COD to collect", tk(live.filter((o) => o.status !== "delivered").reduce((s, o) => s + o.total, 0))],
        ["Delivered value", tk(ORDERS.filter((o) => o.status === "delivered").reduce((s, o) => s + o.total, 0))],
        ["All orders", ORDERS.length],
      ].map(([k, v, c]) => `<div class="stat ${c || ""}"><b>${v}</b><span>${k}</span></div>`).join("");
      $("#rows").innerHTML = list.length ? list.map((o) => `<tr>
        <td class="num"><b>${esc(o.id)}</b><small>${esc(o.created_bd)}</small><div class="acts"><button class="btn sm" data-invoice="${esc(o.id)}">Invoice</button></div></td>
        <td>${esc(o.name)}<small>${esc(o.phone)}${o.alt_phone ? " / " + esc(o.alt_phone) : ""}</small>
          <div class="acts"><a class="btn sm" href="tel:${esc(o.phone)}">Call</a><a class="btn sm wa" href="${waLink(o)}" target="_blank" rel="noopener">WhatsApp</a></div></td>
        <td>${esc(o.address)}<small>${esc(o.district)} · ${esc(o.zone)}${o.note ? " · Note: " + esc(o.note) : ""}</small></td>
        <td>${esc(o.items_summary)}</td>
        <td class="num">${tk(o.total)}<small>incl. ${tk(o.delivery)} delivery</small></td>
        <td><select data-id="${esc(o.id)}" class="s-${esc(o.status)}">${STATUSES.map((s) => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}</select>${o.updated_bd ? `<small>Updated ${esc(o.updated_bd)}</small>` : ""}</td>
        <td><input data-note="${esc(o.id)}" value="${esc(o.admin_note)}" placeholder="Courier, tracking…" maxlength="500"></td>
      </tr>`).join("") : `<tr><td colspan="7" class="muted">${ORDERS.length ? "No orders match." : "No orders yet. Share the site!"}</td></tr>`;
      $("#synced").textContent = "Updated " + new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });
    }
    $("#q").oninput = renderOrders;
    $("#filter").onchange = renderOrders;
    $("#refresh").onclick = () => loadOrders().then(() => toast("Orders refreshed")).catch((e) => toast(e.message, true));
    $("#copy").onclick = () => navigator.clipboard.writeText($("#csvurl").textContent).then(() => toast("Copied"));
    $("#rows").addEventListener("change", async (e) => {
      const sel = e.target.closest("select[data-id]"); if (!sel) return;
      try {
        await api(`/api/orders/${sel.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: sel.value }) });
        const o = ORDERS.find((x) => x.id === sel.dataset.id); o.status = sel.value;
        toast(["cancelled", "returned"].includes(sel.value) ? "Status saved. Items are back in stock." : "Status saved");
        renderOrders(); loadProducts().catch(() => {});
      } catch (ex) { toast(ex.message, true); }
    });
    $("#rows").addEventListener("focusout", async (e) => {
      const inp = e.target.closest("input[data-note]"); if (!inp) return;
      const o = ORDERS.find((x) => x.id === inp.dataset.note);
      if (!o || (o.admin_note || "") === inp.value) return;
      try { await api(`/api/orders/${o.id}`, { method: "PATCH", body: JSON.stringify({ admin_note: inp.value }) }); o.admin_note = inp.value; toast("Note saved"); }
      catch (ex) { toast(ex.message, true); }
    });
    $("#rows").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[data-note]")) e.target.blur(); });
    $("#rows").addEventListener("click", (e) => {
      const b = e.target.closest("[data-invoice]"); if (!b) return;
      printInvoice(ORDERS.find((o) => o.id === b.dataset.invoice));
    });
    function printInvoice(o) {
      const w = window.open("", "_blank");
      if (!w) { toast("Allow pop-ups to print invoices", true); return; }
      const lines = (o.items && o.items.length ? o.items : [{ name: o.items_summary, color: "", size: "", qty: o.item_count, unit: o.subtotal, total: o.subtotal }]);
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(o.id)}</title>
        <style>body{font:14px/1.5 Arial,sans-serif;color:#111;margin:32px;max-width:720px}h1{font-size:28px;letter-spacing:.08em;margin:0}
        .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:12px;margin-bottom:18px}
        table{width:100%;border-collapse:collapse;margin:16px 0}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}th{background:#f3f3f3;font-size:12px;text-transform:uppercase}
        td.r,th.r{text-align:right}.tot td{font-weight:bold;font-size:16px;border-top:2px solid #111}.box{border:1px solid #ddd;padding:12px;margin-top:8px}
        .cod{display:inline-block;background:#111;color:#fff;padding:6px 10px;font-weight:bold;letter-spacing:.06em;margin-top:8px}@media print{button{display:none}body{margin:12mm}}</style></head><body>
        <div class="top"><div><h1>ODDKULT</h1><div>oddkult.com · ${esc(SETTINGS.phone || "")}</div></div><div style="text-align:right"><b>Invoice ${esc(o.id)}</b><br>${esc(o.created_bd)}</div></div>
        <div class="box"><b>Deliver to:</b> ${esc(o.name)} · ${esc(o.phone)}${o.alt_phone ? " / " + esc(o.alt_phone) : ""}<br>${esc(o.address)}, ${esc(o.district)} (${esc(o.zone)})${o.note ? `<br><b>Note:</b> ${esc(o.note)}` : ""}</div>
        <table><tr><th>Item</th><th>Colour</th><th>Size</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr>
        ${lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.color)}</td><td>${esc(l.size)}</td><td class="r">${l.qty}</td><td class="r">${tk(l.unit)}</td><td class="r">${tk(l.total)}</td></tr>`).join("")}
        <tr><td colspan="5" class="r">Subtotal</td><td class="r">${tk(o.subtotal)}</td></tr>
        <tr><td colspan="5" class="r">Delivery</td><td class="r">${o.delivery ? tk(o.delivery) : "Free"}</td></tr>
        <tr class="tot"><td colspan="5" class="r">Collect on delivery</td><td class="r">${tk(o.total)}</td></tr></table>
        <div class="cod">CASH ON DELIVERY · ${tk(o.total)}</div>
        <p style="margin-top:28px;color:#555">Thank you for joining the kult. Exchanges within 7 days for unused items.</p>
        </body></html>`);
      w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
    }
    $("#xlsx").onclick = () => {
      const rows = ORDERS.map((o) => Object.fromEntries(COLUMNS.map(([k, label]) => [label, o[k]])));
      const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS.map((c) => c[1]) });
      ws["!cols"] = COLUMNS.map(([k]) => ({ wch: k === "address" || k === "items_summary" ? 48 : k === "note" || k === "admin_note" ? 30 : 16 }));
      ws["!autofilter"] = { ref: ws["!ref"] };
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Orders");
      XLSX.writeFile(wb, `oddkult-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
    };
    setInterval(() => {
      if (!KEY || $("#app").hidden || document.hidden || !$("#drawer").hidden) return;
      const a = document.activeElement;
      if (a && a.closest && (a.closest("#rows") || a.closest("#plist") || a.closest("form"))) return;
      if (TAB === "orders") loadOrders().catch(() => {});
      if (TAB === "products") loadProducts().catch(() => {});
    }, 30000);

    /* ---------------- products ---------------- */
    async function loadProducts() {
      const d = await api("/api/admin/products");
      PRODUCTS = d.products; COLLECTIONS = d.collections;
      const opts = COLLECTIONS.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
      const cur = $("#pcat").value;
      $("#pcat").innerHTML = `<option value="">All categories</option>${opts}`; $("#pcat").value = cur;
      $("#fcat").innerHTML = opts;
      renderProducts();
    }
    const colName = (id) => COLLECTIONS.find((c) => c.id === id)?.name || id;
    function renderProducts() {
      const q = $("#pq").value.trim().toLowerCase();
      const cat = $("#pcat").value;
      const list = PRODUCTS.filter((p) => (!cat || p.collection === cat) && (!q || `${p.name} ${p.type} ${p.id}`.toLowerCase().includes(q)));
      const live = PRODUCTS.filter((p) => p.active);
      $("#pstats").innerHTML = [
        ["On the website", live.length],
        ["Hidden", PRODUCTS.length - live.length],
        ["Sold out", live.filter((p) => p.stock === 0).length, live.some((p) => p.stock === 0) ? "alert" : ""],
        ["Low stock (≤5)", live.filter((p) => p.stock > 0 && p.stock <= 5).length],
        ["On sale", live.filter((p) => p.compareAt).length],
      ].map(([k, v, c]) => `<div class="stat ${c || ""}"><b>${v}</b><span>${k}</span></div>`).join("");
      $("#plist").innerHTML = list.length ? list.map((p) => {
        const img0 = p.variants[0]?.images[0];
        const tags = [!p.active ? `<span class="tag hid">Hidden</span>` : "", p.stock === 0 ? `<span class="tag out">Sold out</span>` : p.stock > 0 && p.stock <= 5 ? `<span class="tag low">Low stock</span>` : "", p.compareAt ? `<span class="tag">Sale</span>` : ""].join("");
        return `<div class="pitem ${p.active ? "" : "off"}" data-pid="${esc(p.id)}">
          <img src="${imgUrl(img0, true)}" alt="" loading="lazy">
          <div><h4>${esc(p.name)} ${tags}</h4>
            <div class="meta">${esc(p.type)} · ${esc(colName(p.collection))} · ${p.variants.length} colour${p.variants.length === 1 ? "" : "s"} · ${p.compareAt ? `<s>${tk(p.compareAt)}</s> ` : ""}<b>${tk(p.price)}</b></div></div>
          <div class="ctl">
            <label>Price <input type="number" min="50" step="10" value="${p.price}" data-f="price"></label>
            <label>Stock <input type="number" min="0" step="1" value="${p.stock ?? ""}" placeholder="∞" data-f="stock"></label>
            <label title="Show on website"><span class="switch"><input type="checkbox" data-f="active" ${p.active ? "checked" : ""}><span></span></span> Live</label>
            <button class="btn sm" data-edit="${esc(p.id)}">Edit</button>
          </div></div>`;
      }).join("") : `<div class="empty">${PRODUCTS.length ? "No products match." : "No products yet. Click “Add product”."}</div>`;
    }
    $("#pq").oninput = renderProducts;
    $("#pcat").onchange = renderProducts;
    $("#plist").addEventListener("change", async (e) => {
      const inp = e.target.closest("[data-f]"); if (!inp) return;
      const id = inp.closest("[data-pid]").dataset.pid;
      const f = inp.dataset.f;
      const body = { [f]: f === "active" ? inp.checked : inp.value };
      try { const d = await api(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(body) }); Object.assign(PRODUCTS.find((p) => p.id === id), d.product); renderProducts(); toast("Saved. Live on the website."); }
      catch (ex) { toast(ex.message, true); renderProducts(); }
    });
    $("#plist").addEventListener("click", (e) => { const b = e.target.closest("[data-edit]"); if (b) openEditor(PRODUCTS.find((p) => p.id === b.dataset.edit)); });
    $("#addProduct").onclick = () => openEditor(null);

    /* ---------------- product editor ---------------- */
    let EDIT = null; // product id being edited, or null for new
    let COLOURS = [];
    function openEditor(p) {
      EDIT = p ? p.id : null;
      const f = $("#pform");
      f.reset();
      $("#ptitle").textContent = p ? `Edit ${p.name}` : "Add product";
      $("#delProduct").hidden = !p;
      $("#perr").textContent = "";
      f.name.value = p?.name || ""; f.type.value = p?.type || "";
      f.collection.value = p?.collection || COLLECTIONS[0]?.id || "";
      f.price.value = p?.price ?? ""; f.compareAt.value = p?.compareAt ?? ""; f.stock.value = p?.stock ?? "";
      f.badge.value = p?.badge || ""; f.tagline.value = p?.tagline || ""; f.description.value = p?.description || "";
      f.details.value = (p?.details || []).join("\n"); f.active.checked = p ? p.active : true;
      COLOURS = p ? p.variants.map((v) => ({ id: v.id, name: v.name, swatch: v.swatch || "#141414", price: v.price && v.price !== p.price ? v.price : "", images: [...v.images] })) : [{ name: "Black", swatch: "#141414", price: "", images: [] }];
      renderColours();
      $("#drawer").hidden = false; document.body.style.overflow = "hidden";
      setTimeout(() => f.name.focus(), 50);
    }
    function closeEditor() { $("#drawer").hidden = true; document.body.style.overflow = ""; }
    $$("#drawer [data-close]").forEach((b) => (b.onclick = closeEditor));
    $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeEditor(); });
    function renderColours() {
      $("#colours").innerHTML = COLOURS.map((c, i) => `<div class="colour" data-ci="${i}">
        <div class="colour__top">
          <label>Colour name <input data-c="name" value="${esc(c.name)}" maxlength="40" placeholder="e.g. Black"></label>
          <label>Swatch <input type="color" data-c="swatch" value="${esc(c.swatch)}"></label>
          <label class="vprice">Own price <small>optional</small><input type="number" data-c="price" value="${esc(c.price)}" min="0" step="10" placeholder="same"></label>
          <button type="button" class="btn sm danger vdel" data-cdel ${COLOURS.length === 1 ? "disabled" : ""}>Remove</button>
        </div>
        <div class="thumbs">
          ${c.images.map((im, j) => `<div class="thumb ${j === 0 ? "first" : ""}"><img src="${imgUrl(im, true)}" alt="">
            <button type="button" class="x" data-idel="${j}" aria-label="Remove photo">✕</button>
            <div class="mv">${j > 0 ? `<button type="button" data-ileft="${j}" aria-label="Move left">◀</button>` : ""}${j < c.images.length - 1 ? `<button type="button" data-iright="${j}" aria-label="Move right">▶</button>` : ""}</div></div>`).join("")}
          <label class="upload">+ Add photos<input type="file" accept="image/*" multiple data-upload></label>
        </div></div>`).join("");
    }
    $("#addColour").onclick = () => { COLOURS.push({ name: "", swatch: "#141414", price: "", images: [] }); renderColours(); };
    $("#colours").addEventListener("input", (e) => {
      const el = e.target.closest("[data-c]"); if (!el) return;
      COLOURS[+el.closest("[data-ci]").dataset.ci][el.dataset.c] = el.value;
    });
    $("#colours").addEventListener("click", (e) => {
      const box = e.target.closest("[data-ci]"); if (!box) return;
      const c = COLOURS[+box.dataset.ci];
      const b = e.target.closest("button"); if (!b) return;
      if ("cdel" in b.dataset) { COLOURS.splice(+box.dataset.ci, 1); }
      else if (b.dataset.idel !== undefined) c.images.splice(+b.dataset.idel, 1);
      else if (b.dataset.ileft !== undefined) { const j = +b.dataset.ileft; [c.images[j - 1], c.images[j]] = [c.images[j], c.images[j - 1]]; }
      else if (b.dataset.iright !== undefined) { const j = +b.dataset.iright; [c.images[j + 1], c.images[j]] = [c.images[j], c.images[j + 1]]; }
      else return;
      renderColours();
    });
    $("#colours").addEventListener("change", async (e) => {
      const inp = e.target.closest("[data-upload]"); if (!inp || !inp.files.length) return;
      const c = COLOURS[+inp.closest("[data-ci]").dataset.ci];
      const lab = inp.closest(".upload"); lab.classList.add("busy"); lab.firstChild.textContent = "Uploading…";
      try {
        for (const file of [...inp.files].slice(0, 8)) {
          const blob = await resizeImage(file);
          const d = await api("/api/admin/images", { method: "POST", body: blob, headers: { "content-type": blob.type } });
          c.images.push(d.id);
        }
        toast("Photos uploaded");
      } catch (ex) { toast(ex.message, true); }
      renderColours();
    });
    // Resize in the browser (max 1400 px, WebP or JPEG) so uploads are small and fast.
    async function resizeImage(file) {
      const url = URL.createObjectURL(file);
      try {
        const im = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(`${file.name} is not an image we can read.`)); i.src = url; });
        const scale = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
        const cv = document.createElement("canvas");
        cv.width = Math.round(im.naturalWidth * scale); cv.height = Math.round(im.naturalHeight * scale);
        const ctx = cv.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(im, 0, 0, cv.width, cv.height);
        for (const [type, q] of [["image/webp", 0.82], ["image/jpeg", 0.85], ["image/jpeg", 0.7]]) {
          const blob = await new Promise((ok) => cv.toBlob(ok, type, q));
          if (blob && blob.type === type && blob.size < 1400 * 1024) return blob;
        }
        throw new Error(`${file.name} is too large even after resizing.`);
      } finally { URL.revokeObjectURL(url); }
    }
    $("#pform").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      $("#perr").textContent = "";
      const body = {
        name: f.name.value, type: f.type.value, collection: f.collection.value, price: f.price.value,
        compareAt: f.compareAt.value, stock: f.stock.value, badge: f.badge.value, tagline: f.tagline.value,
        description: f.description.value, details: f.details.value.split("\n"), active: f.active.checked,
        variants: COLOURS.map((c) => ({ id: c.id, name: c.name, swatch: c.swatch, price: c.price, images: c.images })),
      };
      if (COLOURS.some((c) => !c.images.length)) { $("#perr").textContent = "Every colour needs at least one photo (or remove the colour)."; return; }
      const btn = $("#saveProduct"); btn.disabled = true; btn.textContent = "Saving…";
      try {
        await api(EDIT ? `/api/admin/products/${EDIT}` : "/api/admin/products", { method: EDIT ? "PUT" : "POST", body: JSON.stringify(body) });
        closeEditor(); await loadProducts(); toast(EDIT ? "Product updated. Live on the website." : "Product added. Live on the website.");
      } catch (ex) { $("#perr").textContent = ex.message; }
      finally { btn.disabled = false; btn.textContent = "Save and publish"; }
    });
    $("#delProduct").onclick = async () => {
      if (!EDIT || !confirm("Delete this product from the website? This can't be undone. (Tip: switch off “Show on website” to hide it instead.)")) return;
      try { await api(`/api/admin/products/${EDIT}`, { method: "DELETE" }); closeEditor(); await loadProducts(); toast("Product deleted"); }
      catch (ex) { toast(ex.message, true); }
    };

    /* ---------------- categories ---------------- */
    let CATS = [];
    function renderCats() {
      if (!CATS.length) CATS = COLLECTIONS.map((c) => ({ ...c }));
      $("#cats").innerHTML = CATS.map((c, i) => {
        const n = PRODUCTS.filter((p) => p.collection === c.id).length;
        return `<div class="cat" data-i="${i}">
          <label>Name <input data-k="name" value="${esc(c.name)}" maxlength="30"></label>
          <label>Short description <small>${n} product${n === 1 ? "" : "s"}</small><input data-k="blurb" value="${esc(c.blurb)}" maxlength="120"></label>
          <div class="acts"><button class="btn sm" data-up ${i === 0 ? "disabled" : ""}>▲</button><button class="btn sm" data-down ${i === CATS.length - 1 ? "disabled" : ""}>▼</button><button class="btn sm danger" data-del ${n ? 'disabled title="Move its products to another category first"' : ""}>Delete</button></div>
        </div>`;
      }).join("");
    }
    $("#cats").addEventListener("input", (e) => { const el = e.target.closest("[data-k]"); if (el) CATS[+el.closest("[data-i]").dataset.i][el.dataset.k] = el.value; });
    $("#cats").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const i = +b.closest("[data-i]").dataset.i;
      if ("up" in b.dataset) [CATS[i - 1], CATS[i]] = [CATS[i], CATS[i - 1]];
      else if ("down" in b.dataset) [CATS[i + 1], CATS[i]] = [CATS[i], CATS[i + 1]];
      else if ("del" in b.dataset) CATS.splice(i, 1);
      renderCats();
    });
    $("#addCat").onclick = () => { CATS.push({ id: "", name: "", blurb: "" }); renderCats(); $$("#cats [data-k=name]").pop().focus(); };
    $("#saveCats").onclick = async () => {
      try {
        const d = await api("/api/admin/collections", { method: "PUT", body: JSON.stringify({ collections: CATS.map((c) => ({ id: c.id || c.name, name: c.name, blurb: c.blurb, cover: c.cover })) }) });
        COLLECTIONS = d.collections; CATS = []; await loadProducts(); renderCats(); toast("Categories saved. Live on the website.");
      } catch (ex) { toast(ex.message, true); }
    };

    /* ---------------- settings ---------------- */
    async function loadSettings() {
      SETTINGS = (await api("/api/admin/settings")).settings;
      const f = $("#settingsForm");
      for (const [k, v] of Object.entries(SETTINGS)) if (f[k]) f[k].value = k === "whatsapp" && v.startsWith("88") ? v.slice(2) : v;
    }
    $("#settingsForm").addEventListener("submit", async (e) => {
      e.preventDefault(); $("#serr").textContent = "";
      const settings = Object.fromEntries(new FormData(e.target));
      try { SETTINGS = (await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ settings }) })).settings; toast("Settings saved. Live on the website."); }
      catch (ex) { $("#serr").textContent = ex.message; }
    });

    if (KEY) start().catch(() => {});
