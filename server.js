const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const pool = require("./db");
const productDetails = require("./products");

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

function credentialsMatch(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function requireAdmin(req, res) {
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) {
    send(res, 503, { error: "Admin login is not configured. Set ADMIN_USER and ADMIN_PASSWORD." });
    return false;
  }
  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    try {
      const [user, ...passwordParts] = Buffer.from(match[1], "base64").toString("utf8").split(":");
      if (credentialsMatch(user || "", adminUser) && credentialsMatch(passwordParts.join(":"), adminPassword)) return true;
    } catch { /* Return the same response for malformed credentials. */ }
  }
  send(res, 401, { error: "Enter your admin username and password." });
  return false;
}

function validateProduct(body) {
  const id = clean(body.id, 40).toLowerCase();
  const name = clean(body.name, 160);
  const description = String(body.description || "").trim().slice(0, 5000);
  const imageUrl = clean(body.image_url, 1000);
  const price = Number(body.price);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("ID must use lowercase letters, numbers, and hyphens.");
  if (!name || !description || !imageUrl || !Number.isFinite(price) || price <= 0) throw new Error("Provide a name, positive price, description, and image URL.");
  return { id, name, price, description, image_url: imageUrl };
}

function presentProduct(row) {
  const details = productDetails.find(item => item.id === row.id) || {};
  return {
    ...details,
    id: row.id,
    name: row.name,
    price: Number(row.price),
    description: row.description,
    image: row.image_url,
    subtitle: details.subtitle || "",
    size: details.size || "",
    gallery: details.gallery || [row.image_url],
    eyebrow: details.eyebrow || "",
    intro: details.intro || row.description,
    notes: details.notes || []
  };
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

  const requestedItems = body.items.map(line => ({ id: clean(line.id, 40), quantity: Number(line.quantity) }));
  if (requestedItems.some(line => !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10)) throw new Error("A product or quantity in your cart is invalid.");
  const productResult = await pool.query("SELECT id, name, price FROM products WHERE id = ANY($1::varchar[])", [requestedItems.map(line => line.id)]);
  const items = requestedItems.map(line => {
    const product = productResult.rows.find(item => item.id === line.id);
    const quantity = line.quantity;
    if (!product) throw new Error("A product or quantity in your cart is invalid.");
    const price = Number(product.price);
    return { id: product.id, name: product.name, price, quantity, lineTotal: price * quantity };
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
    if (req.method === "GET" && url.pathname === "/api/products") {
      const result = await pool.query("SELECT id, name, price, description, image_url FROM products ORDER BY id");
      return send(res, 200, result.rows.map(presentProduct));
    }
    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      const contents = await fs.readFile(path.join(PUBLIC, "admin.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Cache-Control": "no-store" });
      return req.method === "HEAD" ? res.end() : res.end(contents);
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (!requireAdmin(req, res)) return;
      if (url.pathname === "/api/admin/products" && req.method === "GET") {
        const result = await pool.query("SELECT id, name, price, description, image_url FROM products ORDER BY id");
        return send(res, 200, result.rows);
      }
      if (url.pathname === "/api/admin/products" && req.method === "POST") {
        try {
          const product = validateProduct(await readBody(req));
          const result = await pool.query("INSERT INTO products (id, name, price, description, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, price, description, image_url", [product.id, product.name, product.price, product.description, product.image_url]);
          return send(res, 201, result.rows[0]);
        } catch (error) {
          return send(res, error.code === "23505" ? 409 : 400, { error: error.code === "23505" ? "That product ID already exists." : error.message });
        }
      }
      const productMatch = url.pathname.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
      if (productMatch && req.method === "PUT") {
        try {
          const product = validateProduct({ ...await readBody(req), id: productMatch[1] });
          const result = await pool.query("UPDATE products SET name = $2, price = $3, description = $4, image_url = $5 WHERE id = $1 RETURNING id, name, price, description, image_url", [product.id, product.name, product.price, product.description, product.image_url]);
          if (!result.rowCount) return send(res, 404, { error: "Product not found." });
          return send(res, 200, result.rows[0]);
        } catch (error) { return send(res, 400, { error: error.message }); }
      }
      if (productMatch && req.method === "DELETE") {
        const result = await pool.query("DELETE FROM products WHERE id = $1 RETURNING id", [productMatch[1]]);
        if (!result.rowCount) return send(res, 404, { error: "Product not found." });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: "Method not allowed" });
    }
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
