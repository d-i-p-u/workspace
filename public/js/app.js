// ODDKULT storefront — vanilla JS, no build step.

// Contact details, social links and the announcement come from Admin → Settings (/api/catalog → store).
// These are only used if the live catalogue can't be loaded.
const CONFIG = {
  whatsapp: "8801707680854",
  instagram: "",
  facebook: "",
  phone: "01707680854",
};

const DISTRICTS = ["Bagerhat","Bandarban","Barguna","Barishal","Bhola","Bogura","Brahmanbaria","Chandpur","Chapai Nawabganj","Chattogram","Chuadanga","Cox's Bazar","Cumilla","Dhaka (outside city)","Dinajpur","Faridpur","Feni","Gaibandha","Gazipur","Gopalganj","Habiganj","Jamalpur","Jashore","Jhalokathi","Jhenaidah","Joypurhat","Khagrachhari","Khulna","Kishoreganj","Kurigram","Kushtia","Lakshmipur","Lalmonirhat","Madaripur","Magura","Manikganj","Meherpur","Moulvibazar","Munshiganj","Mymensingh","Naogaon","Narail","Narayanganj","Narsingdi","Natore","Netrokona","Nilphamari","Noakhali","Pabna","Panchagarh","Patuakhali","Pirojpur","Rajbari","Rajshahi","Rangamati","Rangpur","Satkhira","Shariatpur","Sherpur","Sirajganj","Sunamganj","Sylhet","Tangail","Thakurgaon"];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const tk = (n) => "৳" + Number(n).toLocaleString("en-IN");
// Image names: "p06" uses our optimised p06.webp / p06-sm.webp pair.
// A name with an extension (e.g. "new-belt.jpg") is used as-is from img/products/.
// A name starting with "u/" is a photo uploaded from the admin panel (served from the database).
const img = (id, sm) =>
  id.startsWith("u/") ? `/img/${id}` : id.includes(".") ? `img/products/${id}` : `img/products/${id}${sm ? "-sm" : ""}.webp`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let DATA = null;
const state = { filter: "all", sort: "featured", cart: loadCart() };

function loadCart() {
  try { return JSON.parse(localStorage.getItem("oddkult:cart")) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem("oddkult:cart", JSON.stringify(state.cart)); } catch { /* private mode */ }
}
const product = (id) => DATA.products.find((p) => p.id === id);
const variantPrice = (p, v) => v.price ?? p.price;
const minPrice = (p) => Math.min(...p.variants.map((v) => variantPrice(p, v)));
const soldOut = (p) => p.stock === 0;
const lowStock = (p) => typeof p.stock === "number" && p.stock > 0 && p.stock <= 5;
const store = () => ({ ...CONFIG, ...((DATA && DATA.store) || {}) });

// ---------- Grid ----------
function cardHTML(p) {
  const v = p.variants[0];
  const second = v.images[1] || p.variants[1]?.images[0];
  const from = p.variants.some((x) => x.price && x.price !== p.price) ? "From " : "";
  const label = soldOut(p) ? "Sold out" : p.compareAt ? "Sale" : p.badge;
  const badge = label
    ? `<span class="card__badge ${soldOut(p) ? "card__badge--out" : label === "Hot" || label === "Sale" ? "card__badge--hot" : ""}">${esc(label)}</span>`
    : "";
  return `<article class="card ${soldOut(p) ? "is-out" : ""}">
    <div class="card__media">
      ${badge}
      <img src="${img(v.images[0], true)}" alt="${esc(p.name)} ${esc(p.type)} in ${esc(v.name)}" loading="lazy" width="600" height="600">
      ${second ? `<img src="${img(second, true)}" alt="" loading="lazy" width="600" height="600">` : ""}
      <button class="card__quick" data-quick="${p.id}">${soldOut(p) ? "Sold out" : "Choose size +"}</button>
    </div>
    <div class="card__row">
      <div><h3 class="card__name">${esc(p.name)}</h3><p class="card__type">${esc(p.type)}</p></div>
      <span class="card__price">${p.compareAt ? `<s>${tk(p.compareAt)}</s> ` : ""}${from}${tk(minPrice(p))}</span>
    </div>
    ${lowStock(p) ? `<p class="card__stock">Only ${p.stock} left</p>` : ""}
    <div class="swatches" aria-label="${p.variants.length} colours">${p.variants.map((x) => `<span class="sw" style="background:${x.swatch}" title="${esc(x.name)}"></span>`).join("")}</div>
    <a class="card__link" href="#p-${p.id}" aria-label="View ${esc(p.name)} ${esc(p.type)}"></a>
  </article>`;
}

// ---------- Motion: fade sections in as they scroll into view ----------
const motionOK = "IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealer = motionOK
  ? new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px" })
  : null;
function reveal(els) {
  if (!revealer) return;
  [...els].forEach((el, i) => {
    if (el.classList.contains("in")) return;
    el.classList.add("reveal");
    el.style.transitionDelay = `${(i % 4) * 70}ms`;
    revealer.observe(el);
  });
}

function renderGrid() {
  let list = DATA.products.filter((p) => state.filter === "all" || p.collection === state.filter);
  if (state.sort === "low") list = [...list].sort((a, b) => minPrice(a) - minPrice(b));
  if (state.sort === "high") list = [...list].sort((a, b) => minPrice(b) - minPrice(a));
  $("[data-grid]").innerHTML = list.map(cardHTML).join("");
  reveal($$("[data-grid] .card"));
}

function renderCollections() {
  const cols = DATA.collections;
  const coverOf = (c) => {
    if (c.cover) return c.cover;
    const p = DATA.products.find((x) => x.collection === c.id);
    return p ? p.variants[0].images[0] : null;
  };
  $$("[data-col-links]").forEach((el) => {
    el.innerHTML = cols.map((c) => `<a href="#shop" data-filter-link="${esc(c.id)}">${esc(c.name)}</a>`).join("");
  });
  $("[data-col-chips]").innerHTML = cols
    .map((c) => `<button class="chip" data-filter="${esc(c.id)}" role="tab" aria-selected="false">${esc(c.name)}</button>`)
    .join("");
  $("[data-col-tiles]").innerHTML = cols
    .map((c) => {
      const cover = coverOf(c);
      return `<button class="col-tile" data-filter-link="${esc(c.id)}">
        ${cover ? `<img src="${img(cover, true)}" alt="" loading="lazy">` : ""}
        <span class="col-tile__label"><b>${esc(c.name)}</b></span>
        <span class="col-tile__blurb">${esc(c.blurb || "")}</span>
      </button>`;
    })
    .join("");
  const pad = (n) => String(n).padStart(2, "0");
  $("[data-col-count]").textContent = `${pad(cols.length)} collections / ${DATA.products.length} designs`;
}

function setFilter(f) {
  state.filter = f;
  $$("[data-filter]").forEach((b) => {
    const on = b.dataset.filter === f;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on);
  });
  renderGrid();
}

// ---------- Product page ----------
function openProduct(id, variantId) {
  const p = product(id);
  if (!p) return;
  let v = p.variants.find((x) => x.id === variantId) || p.variants[0];
  let size = null, qty = 1, imgIdx = 0;
  const box = $("[data-pdp]");
  const body = $("[data-pdp-body]");

  const related = DATA.products.filter((x) => x.collection === p.collection && x.id !== p.id).slice(0, 4);

  const draw = () => {
    const images = v.images;
    body.innerHTML = `
      <div class="pdp__gallery">
        <img class="pdp__main" src="${img(images[imgIdx])}" alt="${esc(p.name)} ${esc(p.type)} — ${esc(v.name)}" width="1200" height="1200">
        ${images.length > 1 ? `<div class="pdp__thumbs">${images.map((im, i) => `<button class="${i === imgIdx ? "is-active" : ""}" data-img="${i}" aria-label="Image ${i + 1}"><img src="${img(im, true)}" alt=""></button>`).join("")}</div>` : ""}
      </div>
      <div class="pdp__info">
        <button class="iconbtn pdp__close" data-close-pdp aria-label="Close">✕</button>
        <div>
          <p class="mono kicker">${esc(DATA.collections.find((c) => c.id === p.collection).name)} collection</p>
          <h2 class="pdp__title" id="pdp-title">${esc(p.name)}</h2>
          <p class="pdp__type">${esc(p.type)} — ${esc(p.tagline)}</p>
        </div>
        <div class="pdp__price">${p.compareAt ? `<s>${tk(p.compareAt)}</s>` : ""}${tk(variantPrice(p, v))}<small>Cash on delivery</small></div>
        ${soldOut(p) ? `<p class="pdp__stock pdp__stock--out">Sold out. Message us on WhatsApp to get notified when it's back.</p>` : lowStock(p) ? `<p class="pdp__stock">Only ${p.stock} left</p>` : ""}
        <div>
          <div class="opt-label mono"><span>Colour</span><span>${esc(v.name)}</span></div>
          <div class="colors">${p.variants.map((x) => `<button class="color-btn ${x.id === v.id ? "is-active" : ""}" data-variant="${x.id}"><span class="sw" style="background:${x.swatch}"></span>${esc(x.name)}</button>`).join("")}</div>
        </div>
        <div>
          <div class="opt-label mono"><span>Waist size</span><a href="#faq" data-close-pdp class="muted">Size guide</a></div>
          <div class="sizes">${DATA.sizes.map((s) => `<button class="size-btn ${s.id === size ? "is-active" : ""}" data-size="${s.id}">${s.id}<small>${esc(s.label.split("·")[1].trim())}</small></button>`).join("")}</div>
        </div>
        <div class="pdp__buy">
          <div class="qty"><button data-qty="-1" aria-label="Less">−</button><output>${qty}</output><button data-qty="1" aria-label="More">+</button></div>
          ${soldOut(p)
            ? `<button class="btn btn--ghost" disabled>Sold out</button>`
            : `<button class="btn btn--chrome" data-add>Add to bag · ${tk(variantPrice(p, v) * qty)}</button>`}
        </div>
        <p class="pdp__desc">${esc(p.description)}</p>
        <ul class="pdp__details">${p.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
        <div class="pdp__ship">
          <div><b>Inside Dhaka</b>1–2 days · ${tk(DATA.delivery.insideDhaka)}</div>
          <div><b>Outside Dhaka</b>2–4 days · ${tk(DATA.delivery.outsideDhaka)}</div>
        </div>
      </div>
      ${related.length ? `<div class="pdp__related"><div class="section-head"><h3 class="h2" style="font-size:clamp(1.4rem,3vw,2.2rem)">More ${esc(p.collection)}</h3></div><div class="grid">${related.map(cardHTML).join("")}</div></div>` : ""}`;
  };

  body.onclick = (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.dataset.variant) { v = p.variants.find((x) => x.id === t.dataset.variant); imgIdx = 0; draw(); }
    else if (t.dataset.img) { imgIdx = +t.dataset.img; draw(); }
    else if (t.dataset.size) { size = t.dataset.size; draw(); }
    else if (t.dataset.qty) { qty = Math.min(10, typeof p.stock === "number" ? Math.max(p.stock, 1) : 10, Math.max(1, qty + +t.dataset.qty)); draw(); }
    else if ("add" in t.dataset) {
      if (soldOut(p)) return;
      if (!size) { toast("Pick your waist size first"); $(".sizes", body).animate([{ transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "none" }], { duration: 300 }); return; }
      addToCart(p.id, v.id, size, qty);
      closeProduct();
      openCart();
    } else if ("closePdp" in t.dataset) { closeProduct(); }
    else if (t.dataset.quick) { e.preventDefault(); openProduct(t.dataset.quick); }
  };

  draw();
  box.hidden = false;
  box.scrollTop = 0;
  document.body.classList.add("locked");
  document.title = `${p.name} ${p.type} — ODDKULT`;
  if (location.hash !== `#p-${p.id}`) location.hash = `p-${p.id}`;
}

function closeProduct() {
  const box = $("[data-pdp]");
  if (box.hidden) return;
  box.hidden = true;
  document.body.classList.remove("locked");
  document.title = "ODDKULT — Punk & Cult Accessories · Bangladesh";
  if (location.hash.startsWith("#p-")) history.replaceState(null, "", "#shop");
}

// ---------- Cart ----------
function addToCart(productId, variantId, size, qty) {
  const hit = state.cart.find((l) => l.productId === productId && l.variantId === variantId && l.size === size);
  if (hit) hit.qty = Math.min(10, hit.qty + qty);
  else state.cart.push({ productId, variantId, size, qty });
  saveCart();
  renderCart();
  const c = $("[data-cart-count]");
  c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump");
}

function cartLines() {
  return state.cart
    .map((l) => {
      const p = product(l.productId);
      const v = p?.variants.find((x) => x.id === l.variantId);
      return p && v ? { ...l, p, v, unit: variantPrice(p, v) } : null;
    })
    .filter(Boolean);
}

function totals(zone) {
  const lines = cartLines();
  const subtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  const d = DATA.delivery;
  const delivery = subtotal === 0 || subtotal >= d.freeOver ? 0 : zone === "inside" ? d.insideDhaka : d.outsideDhaka;
  return { lines, subtotal, delivery, total: subtotal + delivery };
}

function lineHTML(l, i, editable = true) {
  return `<div class="line">
    <img src="${img(l.v.images[0], true)}" alt="">
    <div>
      <h4>${esc(l.p.name)} <span class="muted">${esc(l.p.type)}</span></h4>
      <p>${esc(l.v.name)} · Size ${esc(l.size)}${editable ? "" : ` · ×${l.qty}`}</p>
      ${editable ? `<div class="qty"><button data-line-qty="${i}" data-d="-1" aria-label="Less">−</button><output>${l.qty}</output><button data-line-qty="${i}" data-d="1" aria-label="More">+</button></div>` : ""}
    </div>
    <div class="line__price"><span>${tk(l.unit * l.qty)}</span>${editable ? `<button class="line__remove" data-remove="${i}">Remove</button>` : ""}</div>
  </div>`;
}

function renderCart() {
  const { lines, subtotal } = totals("inside");
  const count = lines.reduce((s, l) => s + l.qty, 0);
  $("[data-cart-count]").textContent = count;
  const body = $("[data-cart-body]");
  const foot = $("[data-cart-foot]");
  if (!lines.length) {
    body.innerHTML = `<div class="cart__empty"><img src="brand/oddkult-icon-bone.svg" alt=""><p>Your bag is empty. Not very kult of you.</p><button class="btn btn--ghost" data-close-cart data-go-shop>Shop the drop</button></div>`;
    foot.innerHTML = "";
    return;
  }
  body.innerHTML = lines.map((l, i) => lineHTML(l, i)).join("");
  const left = DATA.delivery.freeOver - subtotal;
  const pct = Math.min(100, (subtotal / DATA.delivery.freeOver) * 100);
  foot.innerHTML = `
    <div class="free-bar">${left > 0 ? `Add <b>${tk(left)}</b> more for free delivery` : "You've unlocked <b>free delivery</b> ✦"}
      <div class="free-bar__track"><div class="free-bar__fill" style="width:${pct}%"></div></div></div>
    <div class="tot"><span>Subtotal</span><span>${tk(subtotal)}</span></div>
    <button class="btn btn--chrome btn--block" data-open-checkout>Checkout · Cash on delivery</button>
    <p class="muted small" style="margin:0;text-align:center">Delivery is calculated at checkout.</p>`;
}

function openCart() {
  $("[data-cart]").classList.add("is-open");
  $("[data-cart]").setAttribute("aria-hidden", "false");
  $("[data-scrim]").hidden = false;
  document.body.classList.add("locked");
}
function closeCart() {
  $("[data-cart]").classList.remove("is-open");
  $("[data-cart]").setAttribute("aria-hidden", "true");
  $("[data-scrim]").hidden = true;
  if ($("[data-pdp]").hidden && $("[data-checkout]").hidden) document.body.classList.remove("locked");
}

// ---------- Checkout ----------
const form = () => $("[data-checkout-form]");
const zoneVal = () => form().zone.value;

function renderSummary() {
  const { lines, subtotal, delivery, total } = totals(zoneVal());
  $("[data-summary]").innerHTML = `
    <span class="cod-pill">✦ Cash on delivery</span>
    ${lines.map((l, i) => lineHTML(l, i, false)).join("")}
    <div class="row"><span>Subtotal</span><span>${tk(subtotal)}</span></div>
    <div class="row"><span>Delivery (${zoneVal() === "inside" ? "inside Dhaka" : "outside Dhaka"})</span><span>${delivery ? tk(delivery) : "Free"}</span></div>
    <div class="row total"><span>Pay on delivery</span><span>${tk(total)}</span></div>`;
}

function openCheckout() {
  if (!cartLines().length) return;
  closeCart();
  $("[data-checkout]").hidden = false;
  document.body.classList.add("locked");
  renderSummary();
  setTimeout(() => form().name.focus(), 50);
}
function closeCheckout() {
  $("[data-checkout]").hidden = true;
  document.body.classList.remove("locked");
}

async function submitOrder(e) {
  e.preventDefault();
  const f = form();
  const err = $("[data-form-error]");
  err.textContent = "";
  $$(".invalid", f).forEach((x) => x.classList.remove("invalid"));

  const data = Object.fromEntries(new FormData(f));
  const phoneOk = /^(?:\+?88)?01[3-9]\d{8}$/.test(String(data.phone).replace(/[\s-]/g, ""));
  const fail = (field, msg) => { f[field].classList.add("invalid"); f[field].focus(); err.textContent = msg; };
  if (String(data.name).trim().length < 2) return fail("name", "Please enter your name.");
  if (!phoneOk) return fail("phone", "Enter a valid mobile number, like 01712345678.");
  if (data.zone === "outside" && !data.district) return fail("district", "Please choose your district.");
  if (String(data.address).trim().length < 8) return fail("address", "Please write your full address (house, road, area).");

  const btn = $("[data-place-order]");
  btn.disabled = true;
  btn.textContent = "Placing order…";
  try {
    if (window.ODDKULT_PREVIEW) {
      await new Promise((r) => setTimeout(r, 600));
      const t = totals(data.zone);
      return finishOrder({ id: "PREVIEW-" + Date.now().toString(36).toUpperCase().slice(-5), total: t.total }, f);
    }
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...data,
        phone: String(data.phone).replace(/[\s-]/g, ""),
        altPhone: String(data.altPhone || "").replace(/[\s-]/g, ""),
        items: state.cart.map(({ productId, variantId, size, qty }) => ({ productId, variantId, size, qty })),
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || "Couldn't place the order. Please try again.");
    finishOrder(out, f);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Place order · Cash on delivery";
  }
}

function finishOrder(out, f) {
    state.cart = [];
    saveCart();
    renderCart();
    f.reset();
    closeCheckout();
    $("[data-done-id]").textContent = out.id;
    $("[data-done-total]").textContent = tk(out.total);
    $("[data-done]").hidden = false;
    $("[data-preview-note]").hidden = !window.ODDKULT_PREVIEW;
    document.body.classList.add("locked");
}

// ---------- Misc ----------
let toastTimer;
function toast(msg) {
  const t = $("[data-toast]");
  t.textContent = msg;
  t.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-on"), 2200);
}

function route() {
  const m = location.hash.match(/^#p-([\w-]+)/);
  if (m) openProduct(m[1]);
  else closeProduct();
}

function renderSocials() {
  const s = store();
  const wa = s.whatsapp ? `https://wa.me/${s.whatsapp}?text=${encodeURIComponent("Hi ODDKULT! I have a question.")}` : "";
  const links = [];
  if (s.instagram) links.push(`<a class="btn btn--chrome" href="${esc(s.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (s.facebook) links.push(`<a class="btn btn--ghost" href="${esc(s.facebook)}" target="_blank" rel="noopener">Facebook</a>`);
  if (wa) links.push(`<a class="btn ${links.length ? "btn--ghost" : "btn--chrome"}" href="${wa}" target="_blank" rel="noopener">WhatsApp us</a>`);
  $("[data-socials]").innerHTML = links.join("");
  const fc = $("[data-footer-contact]");
  fc.innerHTML = `<h4 class="mono">Kult HQ</h4><span>Dhaka, Bangladesh</span>`;
  if (s.phone) fc.insertAdjacentHTML("beforeend", `<a href="tel:${esc(s.phone)}">Call ${esc(s.phone)}</a>`);
  if (wa) fc.insertAdjacentHTML("beforeend", `<a href="${wa}" target="_blank" rel="noopener">WhatsApp</a>`);
  if (s.instagram) fc.insertAdjacentHTML("beforeend", `<a href="${esc(s.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (s.facebook) fc.insertAdjacentHTML("beforeend", `<a href="${esc(s.facebook)}" target="_blank" rel="noopener">Facebook</a>`);
  fc.insertAdjacentHTML("beforeend", `<a href="#track" data-open-track>Track your order</a>`);
  const fab = $("[data-wa-fab]");
  if (fab) { fab.hidden = !wa; if (wa) fab.href = wa; }
  if (s.announcement) {
    const track = $(".announce__track");
    if (track && !track.dataset.custom) {
      track.dataset.custom = "1";
      const item = `<span>${esc(s.announcement)}</span><i>✦</i>`;
      track.insertAdjacentHTML("afterbegin", item);
      const half = track.children.length / 2;
      track.children[Math.floor(half)]?.insertAdjacentHTML("beforebegin", item);
    }
  }
}

function renderDeliveryCopy() {
  const d = DATA.delivery;
  $$("[data-d-in]").forEach((el) => (el.textContent = tk(d.insideDhaka)));
  $$("[data-d-out]").forEach((el) => (el.textContent = tk(d.outsideDhaka)));
  $$("[data-d-free]").forEach((el) => (el.textContent = tk(d.freeOver)));
}

function openTrack() {
  closeMenu();
  $("[data-track]").hidden = false;
  document.body.classList.add("locked");
  setTimeout(() => $("[data-track-form]").oid.focus(), 50);
}
function closeTrack() {
  $("[data-track]").hidden = true;
  document.body.classList.remove("locked");
  if (location.hash === "#track") history.replaceState(null, "", location.pathname);
}

// ---------- Order tracking ----------
async function trackOrder(e) {
  e.preventDefault();
  const f = e.target;
  const out = $("[data-track-result]");
  out.innerHTML = `<p class="muted">Checking…</p>`;
  try {
    const res = await fetch(`/api/track?id=${encodeURIComponent(f.oid.value.trim())}&phone=${encodeURIComponent(f.phone.value.trim())}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Couldn't check right now.");
    const steps = ["new", "confirmed", "shipped", "delivered"];
    const label = { new: "Order received", confirmed: "Confirmed", shipped: "On the way", delivered: "Delivered", cancelled: "Cancelled", returned: "Returned" };
    const at = steps.indexOf(d.status);
    out.innerHTML = `
      <p class="track__status mono">${esc(label[d.status] || d.status)}</p>
      ${at >= 0 ? `<ol class="track__steps">${steps.map((s, i) => `<li class="${i <= at ? "is-done" : ""}">${label[s]}</li>`).join("")}</ol>` : ""}
      <p class="muted small">${esc(d.items)} · ${tk(d.total)} cash on delivery · placed ${esc(d.placed)}</p>`;
  } catch (ex) {
    out.innerHTML = `<p class="form__error">${esc(ex.message)}</p>`;
  }
}

function closeMenu() { $("[data-menu]").hidden = true; document.body.classList.remove("locked"); }

async function init() {
  $("[data-year]").textContent = new Date().getFullYear();
  $("[data-district]").innerHTML = `<option value="">Select district…</option>` + DISTRICTS.map((d) => `<option>${d}</option>`).join("");
  renderSocials();

  try {
    // Live catalogue (prices / visibility set from the Google Sheet); static file as fallback.
    const live = await fetch("/api/catalog", { cache: "no-store" }).catch(() => null);
    DATA = live && live.ok ? await live.json() : await (await fetch("data/products.json")).json();
  } catch {
    $("[data-grid]").innerHTML = `<p class="muted">Couldn't load products. Please refresh.</p>`;
    return;
  }
  // drop cart lines for products that no longer exist or are sold out
  state.cart = state.cart.filter((l) => product(l.productId)?.variants.some((v) => v.id === l.variantId) && !soldOut(product(l.productId)));
  renderSocials();
  renderDeliveryCopy();
  renderCollections();
  reveal($$(".col-tile"));
  reveal($$(".section-head, .promise, .manifesto__icon, .manifesto__text, .soon__copy, .faq details, .footer__top"));
  const nav = $(".nav");
  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 24);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  renderGrid();
  renderCart();
  route();

  $("[data-track-form]").addEventListener("submit", trackOrder);
  if (location.hash === "#track") openTrack();

  document.addEventListener("click", (e) => {
    const tr = e.target.closest("[data-open-track],[data-close-track]");
    if (tr) {
      e.preventDefault();
      if ("openTrack" in tr.dataset) openTrack();
      else closeTrack();
      return;
    }
    const t = e.target.closest("[data-filter],[data-filter-link],[data-quick],[data-open-cart],[data-close-cart],[data-open-checkout],[data-close-checkout],[data-close-done],[data-remove],[data-line-qty],[data-open-menu],[data-close-menu],[data-scrim],.menu a");
    if (!t || t.closest("[data-pdp]")) return;
    if (t.dataset.filter) setFilter(t.dataset.filter);
    if (t.dataset.filterLink) { setFilter(t.dataset.filterLink); closeMenu(); if (t.tagName === "BUTTON") $("#shop").scrollIntoView(); }
    if (t.matches(".menu a")) closeMenu();
    if (t.dataset.quick) { e.preventDefault(); openProduct(t.dataset.quick); }
    if ("openCart" in t.dataset) openCart();
    if ("closeCart" in t.dataset || "scrim" in t.dataset) { closeCart(); if ("goShop" in t.dataset) $("#shop").scrollIntoView(); }
    if ("openCheckout" in t.dataset) openCheckout();
    if ("closeCheckout" in t.dataset) { closeCheckout(); openCart(); }
    if ("closeDone" in t.dataset) { $("[data-done]").hidden = true; document.body.classList.remove("locked"); }
    if ("openMenu" in t.dataset) { $("[data-menu]").hidden = false; document.body.classList.add("locked"); }
    if ("closeMenu" in t.dataset) closeMenu();
    if (t.dataset.remove) { state.cart.splice(+t.dataset.remove, 1); saveCart(); renderCart(); }
    if (t.dataset.lineQty) {
      const l = state.cart[+t.dataset.lineQty];
      l.qty = Math.min(10, l.qty + +t.dataset.d);
      if (l.qty < 1) state.cart.splice(+t.dataset.lineQty, 1);
      saveCart(); renderCart();
    }
  });

  $("[data-sort]").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  form().addEventListener("submit", submitOrder);
  form().addEventListener("change", (e) => {
    if (e.target.name === "zone") {
      $("[data-district-wrap]").hidden = zoneVal() !== "outside";
      renderSummary();
    }
  });
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("[data-pdp]").hidden) closeProduct();
    else if ($("[data-cart]").classList.contains("is-open")) closeCart();
    else if (!$("[data-checkout]").hidden) closeCheckout();
    else if (!$("[data-track]").hidden) closeTrack();
  });
}

init();
