const money = value => `Rs. ${Number(value || 0).toLocaleString("en-PK")}`;
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let products = [];
let cart = JSON.parse(localStorage.getItem("nutikals-cart") || "[]");
let activeProduct = null;
let detailQuantity = 1;

function saveCart() { localStorage.setItem("nutikals-cart", JSON.stringify(cart)); renderCart(); }
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
  document.querySelectorAll("[data-cart-count]").forEach(el => el.textContent = cartCount());
  document.querySelectorAll("[data-cart-items]").forEach(container => {
    container.innerHTML = cart.length ? cart.map(line => {
      const p = getProduct(line.id); if (!p) return "";
      return `<article class="cart-line"><img src="${safe(p.image)}" alt=""><div class="cart-line-copy"><a href="/product.html?id=${encodeURIComponent(p.id)}">${safe(p.name)}</a><span>${money(p.price)}</span><div class="cart-quantity"><button data-cart-change="-1" data-id="${safe(p.id)}" aria-label="Remove one ${safe(p.name)}">−</button><span>${line.quantity}</span><button data-cart-change="1" data-id="${safe(p.id)}" aria-label="Add one ${safe(p.name)}">+</button><button class="remove-line" data-cart-remove="${safe(p.id)}">Remove</button></div></div><strong>${money(p.price * line.quantity)}</strong></article>`;
    }).join("") : `<div class="empty-bag"><span>✳</span><p>Your bag is taking a little breather.</p><a href="/#shop" class="text-link">Explore the collection →</a></div>`;
  });
  document.querySelectorAll("[data-cart-total]").forEach(el => el.textContent = money(cartSubtotal()));
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
  const homeProducts = ["s9", "bareesh", "s11"].map(getProduct).filter(Boolean);
  grid.innerHTML = homeProducts.map((p, index) => `<article class="product-card"><a class="card-image image-${safe(p.id)}" href="/product.html?id=${encodeURIComponent(p.id)}"><img src="${safe(p.image)}" alt="${safe(p.name)}" loading="lazy"><span class="card-number">0${index + 1}</span><span class="card-arrow">↗</span></a><div class="card-copy"><div class="card-meta"><span>${safe(p.eyebrow)}</span><span>${safe(p.size)}</span></div><h3><a href="/product.html?id=${encodeURIComponent(p.id)}">${safe(p.name)}</a></h3><p>${safe(p.subtitle)}</p><div class="card-bottom"><div>${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ""}<strong>${money(p.price)}</strong></div><button class="quick-add" data-quick-add="${safe(p.id)}" aria-label="Add ${safe(p.name)} to bag">Add to cart</button></div></div></article>`).join("");
  grid.querySelectorAll("[data-quick-add]").forEach(button => button.onclick = () => addToCart(button.dataset.quickAdd));
}
let carouselIndex = 1;
let carouselTimer;
function renderCarousel() {
  const image = document.querySelector("[data-carousel-image]"); if (!image) return;
  const product = products[carouselIndex];
  document.querySelector("[data-carousel-link]").href = `/product.html?id=${encodeURIComponent(product.id)}`;
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
  document.querySelector("[data-summary-count]").textContent = `${count} ${count === 1 ? "item" : "items"}`;
  document.querySelector("[data-summary-subtotal]").textContent = money(cartSubtotal());
  const shipping = !cart.length ? 0 : cartSubtotal() >= 5000 ? 0 : 350;
  document.querySelector("[data-summary-shipping]").textContent = !cart.length ? "—" : shipping === 0 ? "Free" : money(shipping);
  document.querySelector("[data-summary-total]").textContent = money(cartSubtotal() + shipping);
  const form = document.querySelector("[data-checkout-form]");
  const empty = !cart.length;
  form?.classList.toggle("cart-empty", empty);
  const button = document.querySelector("[data-place-order]");
  if (button) button.disabled = empty;
  let emptyNote = document.querySelector("[data-empty-cart-note]");
  if (empty && !emptyNote) { emptyNote = document.createElement("p"); emptyNote.dataset.emptyCartNote = ""; emptyNote.className = "empty-cart-note"; emptyNote.innerHTML = `Your bag is empty. <a href="/#shop">Browse the collection →</a>`; form?.prepend(emptyNote); }
  if (!empty) emptyNote?.remove();
}
function setupCheckout() {
  const form = document.querySelector("[data-checkout-form]"); if (!form) return;
  form.querySelectorAll('input[name="paymentMethod"]').forEach(input => input.addEventListener("change", () => {
    form.querySelectorAll(".payment-option").forEach(option => option.classList.toggle("selected", option.contains(input) && input.checked));
  }));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const message = document.querySelector("[data-form-message]"); const button = document.querySelector("[data-place-order]");
    if (!cart.length) return;
    message.textContent = ""; button.disabled = true; button.innerHTML = "Placing your order…";
    const fields = new FormData(form);
    const payload = { customer: { name: fields.get("name"), phone: fields.get("phone"), email: fields.get("email"), city: fields.get("city"), postalCode: fields.get("postalCode"), address: fields.get("address") }, note: fields.get("note"), paymentMethod: fields.get("paymentMethod"), items: cart };
    try {
      const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "We couldn't place that order. Please try again.");
      const name = fields.get("name").trim().split(/\s+/)[0];
      document.querySelector("[data-success-name]").textContent = name;
      document.querySelector("[data-success-id]").textContent = result.order.id;
      document.querySelector("[data-order-success]").hidden = false;
      document.querySelector(".checkout-layout").hidden = true;
      form.reset(); cart = []; saveCart();
    } catch (error) { message.textContent = error.message; message.classList.add("error"); }
    finally { button.disabled = !cart.length; button.innerHTML = 'Place my order <span>→</span>'; }
  });
}

document.querySelectorAll("[data-cart-open]").forEach(button => button.addEventListener("click", () => toggleDrawer(true)));
document.querySelectorAll("[data-cart-close]").forEach(button => button.addEventListener("click", () => toggleDrawer(false)));
document.addEventListener("keydown", event => { if (event.key === "Escape") toggleDrawer(false); });
document.querySelectorAll("[data-year]").forEach(el => el.textContent = new Date().getFullYear());

fetch("/api/products").then(response => { if (!response.ok) throw new Error("Collection unavailable"); return response.json(); }).then(data => {
  products = data; renderHome(); renderProduct(); renderCart(); setupCheckout(); setupCarousel();
}).catch(() => {
  const grid = document.querySelector("[data-product-grid]"); if (grid) grid.innerHTML = '<p class="load-error">The collection could not load. Please refresh the page.</p>';
  const title = document.querySelector("[data-product-title]"); if (title) title.textContent = "Please refresh to view this product.";
});
