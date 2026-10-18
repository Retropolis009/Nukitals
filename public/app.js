const money = value => `Rs. ${Number(value || 0).toLocaleString("en-PK")}`;
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let products = [];
let cart = [];
let cartReady = false;
let cartSync = Promise.resolve();
let activeProduct = null;
let detailQuantity = 1;
let deliveryFee = 350;
let freeShippingThreshold = 5000;
let publicContent = {};
const pendingOrderKeyStorage = "nutikals-pending-order-key";

// Public marketing copy is optional; existing HTML remains the fallback.
function applyPublicContent() {
  document.querySelectorAll("[data-content]").forEach(element => {
    let value = publicContent[element.dataset.content];
    if (typeof value === "string") {
      if (value === "Free shipping on orders over Rs. 5,000") value = "Free shipping on orders over {threshold}";
      element.textContent = value.replaceAll("{threshold}", money(freeShippingThreshold));
    }
  });
  document.querySelectorAll("[data-content-href]").forEach(element => {
    const value = publicContent[element.dataset.contentHref];
    if (typeof value === "string" && /^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i.test(value)) element.href = value;
  });
}
fetch("./api/site-content", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(content => {
  if (!content) return;
  publicContent = content;
  applyPublicContent();
}).catch(() => {});

function newCheckoutAttemptKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function getCheckoutAttemptKey() {
  const existing = localStorage.getItem(pendingOrderKeyStorage);
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  const key = newCheckoutAttemptKey();
  localStorage.setItem(pendingOrderKeyStorage, key);
  return key;
}

function saveCart() {
  localStorage.setItem("nutikals-cart", JSON.stringify(cart));
  renderCart();
  if (!cartReady) return;
  const items = cart.map(item => ({ id: item.id, quantity: item.quantity }));
  cartSync = cartSync.catch(() => {}).then(async () => {
    const response = await fetch("./api/cart", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Your bag could not be saved.");
  });
  cartSync.catch(() => showToast("Your bag could not be saved. Please try again."));
}
async function loadCart() {
  try {
    const response = await fetch("./api/cart");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Cart unavailable");
    cart = (result.items || []).filter(item => getProduct(item.id)).map(item => ({ id: item.id, quantity: Math.max(1, Math.min(10, Number(item.quantity) || 1)) }));
    if (!cart.length) {
      let previous = [];
      try { previous = JSON.parse(localStorage.getItem("nutikals-cart") || "[]"); } catch { previous = []; }
      cart = Array.isArray(previous) ? previous.filter(item => getProduct(item.id)).map(item => ({ id: item.id, quantity: Math.max(1, Math.min(10, Number(item.quantity) || 1)) })) : [];
    }
  } catch {
    try { const previous = JSON.parse(localStorage.getItem("nutikals-cart") || "[]"); cart = Array.isArray(previous) ? previous : []; } catch { cart = []; }
  }
  cartReady = true;
  if (cart.length) saveCart(); else renderCart();
}
function cartCount() { return cart.reduce((sum, item) => sum + item.quantity, 0); }
function cartSubtotal() { return cart.reduce((sum, item) => sum + ((getProduct(item.id)?.price || 0) * item.quantity), 0); }
function getProduct(id) { return products.find(product => product.id === id); }
function showToast(message) {
  const toast = document.querySelector("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2400);
}
function addToCart(id, quantity = 1) {
  const product = getProduct(id);
  if (!product) return;
  const line = cart.find(item => item.id === id);
  if (line) line.quantity = Math.min(10, line.quantity + quantity);
  else cart.push({ id, quantity: Math.min(10, quantity) });
  saveCart(); showToast(`${product.name} added to your bag`);
}
function changeCart(id, delta) {
  const line = cart.find(item => item.id === id);
  if (!line) return;
  line.quantity += delta;
  if (line.quantity <= 0) cart = cart.filter(item => item.id !== id);
  else line.quantity = Math.min(10, line.quantity);
  saveCart();
}

function renderCart() {
  const count = cartCount();
  document.querySelectorAll("[data-cart-count]").forEach(el => el.textContent = count);
  document.querySelectorAll("[data-cart-open]").forEach(button => button.setAttribute("aria-label", `Open cart, ${count} ${count === 1 ? "item" : "items"}`));
  document.querySelectorAll("[data-cart-items]").forEach(container => {
    container.innerHTML = cart.length ? cart.map(line => {
      const p = getProduct(line.id); if (!p) return "";
      return `<article class="cart-line"><img src="${safe(p.image)}" alt=""><div class="cart-line-copy"><a href="./product.html?id=${encodeURIComponent(p.id)}">${safe(p.name)}</a><span>${money(p.price)} each</span><div class="cart-line-actions"><div class="cart-quantity"><button data-cart-change="-1" data-id="${safe(p.id)}" aria-label="Remove one ${safe(p.name)}">−</button><span>${line.quantity}</span><button data-cart-change="1" data-id="${safe(p.id)}" aria-label="Add one ${safe(p.name)}">+</button></div><button class="remove-line" data-cart-remove="${safe(p.id)}">Remove</button></div></div><strong>${money(p.price * line.quantity)}</strong></article>`;
    }).join("") : `<div class="empty-bag"><span>✳</span><p>Your bag is taking a little breather.</p><a href="./#shop" class="text-link">Explore the collection →</a></div>`;
  });
  const subtotal = cartSubtotal();
  const shipping = !cart.length ? 0 : subtotal >= freeShippingThreshold ? 0 : deliveryFee;
  document.querySelectorAll("[data-delivery-fee]").forEach(el => el.textContent = money(deliveryFee));
  document.querySelectorAll("[data-free-shipping-threshold]").forEach(el => el.textContent = money(freeShippingThreshold));
  document.querySelectorAll("[data-cart-total]").forEach(el => el.textContent = money(subtotal));
  document.querySelectorAll("[data-cart-shipping]").forEach(el => el.textContent = !cart.length ? "—" : shipping === 0 ? "Free" : money(shipping));
  document.querySelectorAll("[data-cart-grand-total]").forEach(el => el.textContent = money(subtotal + shipping));
  document.querySelectorAll("[data-cart-shipping-message]").forEach(el => el.textContent = subtotal >= freeShippingThreshold
    ? (publicContent.shipping_unlocked || "You have unlocked free shipping.")
    : (publicContent.shipping_progress || "Spend {amount} more to unlock free shipping.").replaceAll("{amount}", money(freeShippingThreshold - subtotal)).replaceAll("{threshold}", money(freeShippingThreshold)));
  document.querySelectorAll("[data-cart-shipping-progress]").forEach(el => el.style.width = `${Math.min(100, subtotal / freeShippingThreshold * 100)}%`);
  document.querySelectorAll("[data-cart-change]").forEach(button => button.onclick = () => changeCart(button.dataset.id, Number(button.dataset.cartChange)));
  document.querySelectorAll("[data-cart-remove]").forEach(button => button.onclick = () => { cart = cart.filter(item => item.id !== button.dataset.cartRemove); saveCart(); });
  renderCheckoutSummary();
}

function toggleDrawer(open) {
  const drawer = document.querySelector("[data-cart-drawer]"); if (!drawer) return;
  drawer.classList.toggle("open", open); drawer.setAttribute("aria-hidden", String(!open)); document.body.classList.toggle("drawer-open", open);
}
function renderHome() {
  const grid = document.querySelector("[data-product-grid]"); if (!grid) return;
  const homeOrder = ["s9", "bareesh", "s11"];
  const homeProducts = [...homeOrder.map(getProduct).filter(Boolean), ...products.filter(product => !homeOrder.includes(product.id))];
  grid.innerHTML = homeProducts.map((p, index) => `<article class="product-card"><a class="card-image image-${safe(p.id)}" href="./product.html?id=${encodeURIComponent(p.id)}"><img src="${safe(p.image)}" alt="${safe(p.name)}" loading="lazy"><span class="card-number">0${index + 1}</span><span class="card-arrow">↗</span></a><div class="card-copy"><div class="card-meta"><span>${safe(p.eyebrow)}</span><span>${safe(p.size)}</span></div><h3><a href="./product.html?id=${encodeURIComponent(p.id)}">${safe(p.name)}</a></h3><p>${safe(p.subtitle)}</p><div class="card-bottom"><div>${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ""}<strong>${money(p.price)}</strong></div><button class="quick-add" data-quick-add="${safe(p.id)}" aria-label="Add ${safe(p.name)} to bag">Add to cart</button></div></div></article>`).join("");
  grid.querySelectorAll("[data-quick-add]").forEach(button => button.onclick = () => addToCart(button.dataset.quickAdd));
}
let carouselIndex = 1;
let carouselTimer;
function renderCarousel() {
  const image = document.querySelector("[data-carousel-image]"); if (!image) return;
  const product = products[carouselIndex];
  document.querySelector("[data-carousel-link]").href = `./product.html?id=${encodeURIComponent(product.id)}`;
  image.src = product.image; image.alt = product.name;
  document.querySelector("[data-carousel-title]").textContent = product.name;
  document.querySelector("[data-carousel-price]").textContent = money(product.price);
  const dots = document.querySelector("[data-carousel-dots]");
  dots.innerHTML = products.map((item, index) => `<button class="carousel-dot${index === carouselIndex ? " active" : ""}" data-slide="${index}" aria-label="Show ${safe(item.name)}" aria-current="${index === carouselIndex}"></button>`).join("");
  dots.querySelectorAll("[data-slide]").forEach(dot => dot.onclick = () => setCarousel(Number(dot.dataset.slide)));
  document.querySelector("[data-carousel-add]").onclick = () => addToCart(product.id);
}
function setCarousel(index) {
  carouselIndex = (index + products.length) % products.length;
  renderCarousel();
  clearInterval(carouselTimer);
  carouselTimer = setInterval(() => setCarousel(carouselIndex + 1), 5000);
}
function setupCarousel() {
  if (!document.querySelector("[data-carousel-image]") || !products.length) return;
  document.querySelector("[data-carousel-prev]").onclick = () => setCarousel(carouselIndex - 1);
  document.querySelector("[data-carousel-next]").onclick = () => setCarousel(carouselIndex + 1);
  renderCarousel();
  carouselTimer = setInterval(() => setCarousel(carouselIndex + 1), 5000);
}
function renderProduct() {
  const view = document.querySelector("[data-product-detail]"); if (!view) return;
  activeProduct = getProduct(new URLSearchParams(location.search).get("id"));
  if (!activeProduct) { document.querySelector("[data-product-title]").textContent = "We couldn't find that product"; document.querySelector("[data-product-subtitle]").textContent = "Explore the collection to find your ritual."; return; }
  const p = activeProduct;
  document.title = `${p.name} — Nutikals`;
  document.querySelector("[data-product-name]").textContent = p.name;
  document.querySelector("[data-product-eyebrow]").textContent = p.eyebrow;
  document.querySelector("[data-product-title]").textContent = p.name;
  document.querySelector("[data-product-subtitle]").textContent = p.subtitle;
  document.querySelector("[data-product-price]").innerHTML = `${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ""}<strong>${money(p.price)}</strong>`;
  document.querySelector("[data-product-intro]").textContent = p.intro;
  document.querySelector("[data-product-size]").textContent = p.size;
  document.querySelector("[data-product-description]").textContent = p.description;
  document.querySelector("[data-product-notes]").innerHTML = p.notes.map(note => `<li>${safe(note)}</li>`).join("");
  const image = document.querySelector("[data-product-image]"); image.src = p.image; image.alt = p.name;
  image.onerror = () => { if (image.src !== new URL(p.image, location.href).href) image.src = p.image; else image.hidden = true; };
  const gallery = document.querySelector("[data-product-gallery]");
  if (gallery) {
    gallery.innerHTML = p.gallery.map((src, index) => `<button class="product-thumb${index === 0 ? " selected" : ""}" type="button" data-gallery-src="${safe(src)}" aria-label="View product image ${index + 1}"><img src="${safe(src)}" alt="" loading="lazy"></button>`).join("");
    gallery.querySelectorAll("[data-gallery-src]").forEach(button => {
      const thumb = button.querySelector("img");
      thumb.onerror = () => { thumb.closest("button").hidden = true; };
      button.onclick = () => {
        gallery.querySelectorAll(".product-thumb").forEach(item => item.classList.remove("selected"));
        button.classList.add("selected"); image.hidden = false; image.src = button.dataset.gallerySrc;
        image.onerror = () => { image.src = p.image; };
      };
    });
  }
  document.querySelector("[data-add-product]").onclick = () => addToCart(p.id, detailQuantity);
  document.querySelector("[data-qty-minus]").onclick = () => { detailQuantity = Math.max(1, detailQuantity - 1); document.querySelector("[data-qty]").textContent = detailQuantity; };
  document.querySelector("[data-qty-plus]").onclick = () => { detailQuantity = Math.min(10, detailQuantity + 1); document.querySelector("[data-qty]").textContent = detailQuantity; };
}
function renderCheckoutSummary() {
  const container = document.querySelector("[data-summary-items]"); if (!container) return;
  container.innerHTML = cart.map(line => { const p = getProduct(line.id); if (!p) return ""; return `<div class="summary-product"><div class="summary-thumb"><img src="${safe(p.image)}" alt=""><span>${line.quantity}</span></div><div class="summary-product-name"><strong>${safe(p.name)}</strong><span>${safe(p.size)}</span></div><strong>${money(p.price * line.quantity)}</strong></div>`; }).join("");
  const count = cartCount();
  const countLabel = document.querySelector("[data-summary-count]");
  if (countLabel) countLabel.textContent = `${count} ${count === 1 ? "item" : "items"}`;
  document.querySelector("[data-summary-subtotal]").textContent = money(cartSubtotal());
  const shipping = !cart.length ? 0 : cartSubtotal() >= freeShippingThreshold ? 0 : deliveryFee;
  document.querySelector("[data-summary-shipping]").textContent = !cart.length ? "—" : shipping === 0 ? "Free" : money(shipping);
  document.querySelector("[data-summary-total]").textContent = money(cartSubtotal() + shipping);
  renderPaymentInstructions(cartSubtotal() + shipping);
  const form = document.querySelector("[data-checkout-form]");
  const empty = !cart.length;
  form?.classList.toggle("cart-empty", empty);
  const button = document.querySelector("[data-place-order]");
  if (button) button.disabled = empty;
  let emptyNote = document.querySelector("[data-empty-cart-note]");
  if (empty && !emptyNote) { emptyNote = document.createElement("p"); emptyNote.dataset.emptyCartNote = ""; emptyNote.className = "empty-cart-note"; emptyNote.innerHTML = `Your bag is empty. <a href="./#shop">Browse the collection →</a>`; form?.prepend(emptyNote); }
  if (!empty) emptyNote?.remove();
}
function renderPaymentInstructions(total) {
  const method = document.querySelector('[name="paymentMethod"]')?.value;
  const instructions = document.querySelector("[data-jazzcash-instructions]");
  if (!instructions) return;
  instructions.hidden = method !== "jazzcash";
  document.querySelector("[data-jazzcash-amount]").textContent = money(total);
}
async function refreshStoreSettings() {
  const response = await fetch("./api/store-settings", { cache: "no-store" });
  if (!response.ok) throw new Error("Store settings unavailable");
  const settings = await response.json();
  deliveryFee = Number(settings.deliveryFee);
  freeShippingThreshold = Number(settings.freeShippingThreshold);
  if (!Number.isFinite(deliveryFee) || !Number.isFinite(freeShippingThreshold)) throw new Error("Invalid store settings");
  applyPublicContent();
  renderCart();
}
function setupCheckout() {
  const form = document.querySelector("[data-checkout-form]"); if (!form) return;
  form.querySelector('[name="paymentMethod"]')?.addEventListener("change", () => renderPaymentInstructions(cartSubtotal() + (!cart.length ? 0 : cartSubtotal() >= freeShippingThreshold ? 0 : deliveryFee)));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const message = document.querySelector("[data-form-message]"); const button = document.querySelector("[data-place-order]");
    if (!cart.length) return;
    message.textContent = ""; button.disabled = true; button.innerHTML = "Placing your order…";
    const fields = new FormData(form);
    const payload = { customer: { name: fields.get("name"), phone: fields.get("phone"), email: fields.get("email"), city: fields.get("city"), postalCode: fields.get("postalCode"), address: fields.get("address") }, note: fields.get("note"), paymentMethod: fields.get("paymentMethod"), items: cart.map(item => ({ id: item.id, quantity: item.quantity })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
    let idempotencyKey;
    try {
      idempotencyKey = getCheckoutAttemptKey();
      await cartSync;
      const response = await fetch("./api/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "We couldn't place that order. Please try again.");
      const name = fields.get("name").trim().split(/\s+/)[0];
      document.querySelector("[data-success-name]").textContent = name;
      document.querySelector("[data-success-id]").textContent = result.order.id;
      document.querySelector("[data-order-success]").hidden = false;
      document.querySelector(".checkout-layout").hidden = true;
      localStorage.removeItem(pendingOrderKeyStorage);
      form.reset(); cart = []; saveCart();
    } catch (error) { message.textContent = error.message; message.classList.add("error"); }
    finally { button.disabled = !cart.length; button.innerHTML = 'Place my order <span>→</span>'; }
  });
}

document.querySelectorAll("[data-cart-open]").forEach(button => button.addEventListener("click", () => toggleDrawer(true)));
document.querySelectorAll("[data-cart-close]").forEach(button => button.addEventListener("click", () => toggleDrawer(false)));
document.addEventListener("keydown", event => { if (event.key === "Escape") toggleDrawer(false); });
document.querySelectorAll("[data-year]").forEach(el => el.textContent = new Date().getFullYear());
window.addEventListener("focus", async () => {
  try { await refreshStoreSettings(); renderCart(); }
  catch { /* The last known fee remains visible; the server validates every order total. */ }
});

fetch("./api/products").then(response => { if (!response.ok) throw new Error("Collection unavailable"); return response.json(); }).then(async data => {
  products = data;
  try { await refreshStoreSettings(); } catch { /* Keep the default fee while the store settings endpoint is unavailable. */ }
  renderHome(); renderProduct(); setupCheckout(); setupCarousel(); return loadCart();
}).catch(() => {
  const grid = document.querySelector("[data-product-grid]"); if (grid) grid.innerHTML = '<p class="load-error">The collection could not load. Please refresh the page.</p>';
  const title = document.querySelector("[data-product-title]"); if (title) title.textContent = "Please refresh to view this product.";
});
