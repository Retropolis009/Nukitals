const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const products = require("./products");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const ORDER_FILE = path.join(ROOT, "orders", "orders.jsonl");
const PORT = Number(process.env.PORT || 3000);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Cache-Control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 20_000) reject(new Error("Order is too large")); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}

function clean(value, max = 180) {
  return String(value || "").trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, max);
}

async function createOrder(body) {
  const customer = body.customer || {};
  const name = clean(customer.name, 100);
  const phone = clean(customer.phone, 40);
  const address = clean(customer.address, 500);
  const city = clean(customer.city, 100);
  const postalCode = clean(customer.postalCode, 20);
  if (!name || !phone || !address || !city) throw new Error("Please complete your name, phone, city and delivery address.");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 12) throw new Error("Your cart is empty or invalid.");

  const items = body.items.map(line => {
    const product = products.find(item => item.id === clean(line.id, 40));
    const quantity = Number(line.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error("A product or quantity in your cart is invalid.");
    return { id: product.id, name: product.name, price: product.price, quantity, lineTotal: product.price * quantity };
  });
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const shipping = subtotal >= 5000 ? 0 : 350;
  const order = {
    id: `NK-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    createdAt: new Date().toISOString(),
    customer: { name, phone, city, postalCode, address, email: clean(customer.email, 120) },
    items,
    subtotal,
    shipping,
    total: subtotal + shipping,
    paymentMethod: body.paymentMethod === "jazzcash" ? "jazzcash_manual" : "cash_on_delivery",
    note: clean(body.note, 300),
    status: "new"
  };
  await fs.mkdir(path.dirname(ORDER_FILE), { recursive: true });
  await fs.appendFile(ORDER_FILE, JSON.stringify(order) + "\n", "utf8");
  return order;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/products") return send(res, 200, products);
    if (req.method === "POST" && url.pathname === "/api/orders") {
      try {
        const order = await createOrder(await readBody(req));
        return send(res, 201, { ok: true, order: { id: order.id, total: order.total } });
      } catch (error) { return send(res, 400, { ok: false, error: error.message }); }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });

    let requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.resolve(PUBLIC, `.${requested}`);
    if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, "index.html")) return send(res, 403, { error: "Forbidden" });
    const contents = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime[path.extname(file).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
    return req.method === "HEAD" ? res.end() : res.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, { error: "Not found" });
    console.error(error);
    return send(res, 500, { error: "Something went wrong." });
  }
});

server.listen(PORT, () => console.log(`Nutikals is running at http://localhost:${PORT}`));
