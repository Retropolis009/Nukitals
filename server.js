const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const pool = require("./db");
const productDetails = require("./products");
const nodemailer = require("nodemailer");

const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const CART_COOKIE = "nutikals_cart";
const CART_SECRET = process.env.CART_COOKIE_SECRET || process.env.DB_PASSWORD || "";
const FREE_SHIPPING_THRESHOLD = 5000;
let storeSettingsReady;

async function ensureStoreSettings() {
  if (!storeSettingsReady) {
    storeSettingsReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS store_settings (
        key varchar(80) PRIMARY KEY,
        value numeric(12, 2) NOT NULL CHECK (value >= 0)
      )`);
      await pool.query("INSERT INTO store_settings (key, value) VALUES ('delivery_fee', 350) ON CONFLICT (key) DO NOTHING");
    })().catch(error => { storeSettingsReady = null; throw error; });
  }
  return storeSettingsReady;
}

async function getDeliveryFee(db = pool) {
  await ensureStoreSettings();
  const result = await db.query("SELECT value FROM store_settings WHERE key = 'delivery_fee'");
  return Number(result.rows[0]?.value ?? 350);
}

function clean(value, max = 180) {
  return String(value || "").trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, max);
}

function credentialsMatch(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function requireAdmin(req, res, next) {
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) return res.status(503).json({ error: "Admin login is not configured. Set ADMIN_USER and ADMIN_PASSWORD." });
  const match = (req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
  if (match) {
    try {
      const [user, ...passwordParts] = Buffer.from(match[1], "base64").toString("utf8").split(":");
      if (credentialsMatch(user || "", adminUser) && credentialsMatch(passwordParts.join(":"), adminPassword)) return next();
    } catch { /* Return the same response for malformed credentials. */ }
  }
  return res.status(401).json({ error: "Enter your admin username and password." });
}

function validateProduct(body = {}) {
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

function signCartId(id) {
  return crypto.createHmac("sha256", CART_SECRET).update(id).digest("hex");
}

function cartCookieId(req) {
  if (!CART_SECRET) return null;
  const value = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${CART_COOKIE}=`))?.slice(CART_COOKIE.length + 1);
  if (!value) return null;
  const [id, signature] = value.split(".");
  if (!/^[0-9a-f-]{36}$/i.test(id || "") || !/^[a-f0-9]{64}$/i.test(signature || "")) return null;
  const expected = Buffer.from(signCartId(id), "hex");
  const actual = Buffer.from(signature, "hex");
  return crypto.timingSafeEqual(expected, actual) ? id : null;
}

async function getCartId(req, res) {
  if (!CART_SECRET) throw new Error("Set CART_COOKIE_SECRET or DB_PASSWORD to enable saved carts.");
  await pool.query("DELETE FROM cart_sessions WHERE expires_at < now()");
  let id = cartCookieId(req);
  if (!id) {
    id = crypto.randomUUID();
    const signature = signCartId(id);
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${CART_COOKIE}=${id}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${secure}`);
  }
  await pool.query("INSERT INTO cart_sessions (id, expires_at) VALUES ($1, now() + interval '90 days') ON CONFLICT (id) DO UPDATE SET updated_at = now(), expires_at = now() + interval '90 days'", [id]);
  return id;
}

async function updateCart(cartId, input) {
  if (!Array.isArray(input) || input.length > 12) throw new Error("Your cart is invalid.");
  const items = input.map(line => ({ id: clean(line.id, 40), quantity: Number(line.quantity) }));
  if (items.some(line => !line.id || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10) || new Set(items.map(line => line.id)).size !== items.length) throw new Error("A product or quantity in your cart is invalid.");
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT id FROM products WHERE id = ANY($1::varchar[])", [items.map(line => line.id)]);
    if (result.rows.length !== items.length) throw new Error("A product in your cart is no longer available.");
    await client.query("BEGIN");
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    for (const line of items) await client.query("INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)", [cartId, line.id, line.quantity]);
    await client.query("UPDATE cart_sessions SET updated_at = now(), expires_at = now() + interval '90 days' WHERE id = $1", [cartId]);
    await client.query("COMMIT");
    return items;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function sendOrderEmails(order) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM, EMAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !EMAIL_FROM || !EMAIL_TO) {
    console.warn("Order email not sent: configure SMTP_HOST, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM, and EMAIL_TO.");
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000
  });
  const lines = order.items.map(item => `${item.quantity} x ${item.name} — Rs. ${item.lineTotal.toLocaleString("en-PK")}`).join("\n");
  const text = [
    `Order ${order.id}`,
    `Customer: ${order.customer.name}`,
    `Phone: ${order.customer.phone}`,
    `Email: ${order.customer.email || "not provided"}`,
    `Delivery: ${order.customer.address}, ${order.customer.city} ${order.customer.postalCode}`,
    `Payment: ${order.paymentMethod === "jazzcash_manual" ? "JazzCash (manual transfer; verify payment separately)" : "Cash on delivery"}`,
    "", "Items:", lines,
    "", `Subtotal: Rs. ${order.subtotal.toLocaleString("en-PK")}`,
    `Shipping: Rs. ${order.shipping.toLocaleString("en-PK")}`,
    `Total: Rs. ${order.total.toLocaleString("en-PK")}`,
    `Note: ${order.note || "—"}`
  ].join("\n");
  const deliveries = [transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject: `New Nutikals order ${order.id}`, text })];
  if (order.customer.email) deliveries.push(transporter.sendMail({ from: EMAIL_FROM, to: order.customer.email, subject: `Nutikals order received: ${order.id}`, text: `Hi ${order.customer.name},\n\nWe received your order and our team will contact you to confirm delivery.\n\n${text}` }));
  const results = await Promise.allSettled(deliveries);
  const failed = results.filter(result => result.status === "rejected");
  if (failed.length) console.error(`Email delivery failed for order ${order.id}:`, failed.map(result => result.reason?.message || "Unknown error").join("; "));
  return failed.length === 0;
}

async function createOrder(body = {}, cartId) {
  const customer = body.customer || {};
  const name = clean(customer.name, 100);
  const phone = clean(customer.phone, 40);
  const address = clean(customer.address, 500);
  const city = clean(customer.city, 100);
  const postalCode = clean(customer.postalCode, 20);
  const email = clean(customer.email, 120);
  const note = clean(body.note, 300);
  if (!name || !phone || !address || !city || !postalCode || !note || !email || !["cash_on_delivery", "jazzcash"].includes(body.paymentMethod)) throw new Error("Please complete every checkout field.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cartResult = await client.query("SELECT product_id AS id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY product_id FOR UPDATE", [cartId]);
    const requestedItems = cartResult.rows;
    if (!requestedItems.length || requestedItems.length > 12) throw new Error("Your cart is empty or invalid.");
    const productResult = await client.query("SELECT id, name, price FROM products WHERE id = ANY($1::varchar[])", [requestedItems.map(line => line.id)]);
    const items = requestedItems.map(line => {
      const product = productResult.rows.find(item => item.id === line.id);
      if (!product) throw new Error("A product or quantity in your cart is invalid.");
      const price = Number(product.price);
      return { id: product.id, name: product.name, price, quantity: line.quantity, lineTotal: price * line.quantity };
    });
    const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const deliveryFee = await getDeliveryFee(client);
    const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : deliveryFee;
    const paymentMethod = body.paymentMethod === "jazzcash" ? "jazzcash_manual" : "cash_on_delivery";
    const order = {
      id: `NK-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      createdAt: new Date().toISOString(),
      customer: { name, phone, city, postalCode, address, email },
      items,
      subtotal,
      shipping,
      total: subtotal + shipping,
      paymentMethod,
      paymentStatus: paymentMethod === "cash_on_delivery" ? "due_on_delivery" : "pending",
      note,
      status: "new"
    };
    await client.query(`INSERT INTO orders
      (id, created_at, customer_name, customer_phone, customer_email, delivery_address, delivery_city, delivery_postal_code, payment_method, payment_status, status, note, subtotal, shipping, total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [order.id, order.createdAt, name, phone, order.customer.email || null, address, city, postalCode, paymentMethod, order.paymentStatus, order.status, order.note, subtotal, shipping, order.total]);
    for (const item of items) {
      await client.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total) VALUES ($1,$2,$3,$4,$5,$6)", [order.id, item.id, item.name, item.price, item.quantity, item.lineTotal]);
    }
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    await client.query("COMMIT");
    return order;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "20kb" }));

app.get("/api/products", async (req, res) => {
  const result = await pool.query("SELECT id, name, price, description, image_url FROM products ORDER BY id");
  res.json(result.rows.map(presentProduct));
});

app.get("/api/store-settings", async (req, res) => {
  try { res.json({ deliveryFee: await getDeliveryFee(), freeShippingThreshold: FREE_SHIPPING_THRESHOLD }); }
  catch (error) { console.error("Could not load store settings:", error); res.status(503).json({ error: "Delivery pricing is temporarily unavailable. Please try again shortly." }); }
});

app.get("/api/cart", async (req, res) => {
  const cartId = await getCartId(req, res);
  const result = await pool.query("SELECT product_id AS id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY product_id", [cartId]);
  res.json({ items: result.rows });
});

app.put("/api/cart", async (req, res) => {
  try {
    const cartId = await getCartId(req, res);
    const items = await updateCart(cartId, req.body?.items);
    res.json({ ok: true, items });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.get(["/admin", "/admin.html"], (req, res) => {
  res.set("Cache-Control", "no-store").sendFile(path.join(PUBLIC, "admin.html"));
});

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get("/products", async (req, res) => {
  const result = await pool.query("SELECT id, name, price, description, image_url FROM products ORDER BY id");
  res.json(result.rows);
});

adminRouter.get("/settings", async (req, res) => {
  try { res.json({ deliveryFee: await getDeliveryFee(), freeShippingThreshold: FREE_SHIPPING_THRESHOLD }); }
  catch (error) { console.error("Could not load store settings:", error); res.status(503).json({ error: "Could not load the delivery fee. Check the database connection and try again." }); }
});

adminRouter.put("/settings/delivery-fee", async (req, res) => {
  const fee = Number(req.body?.deliveryFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1000000 || Math.round(fee * 100) !== fee * 100) {
    return res.status(400).json({ error: "Enter a delivery fee from Rs. 0 to Rs. 1,000,000, with up to two decimal places." });
  }
  try {
    await ensureStoreSettings();
    await pool.query("INSERT INTO store_settings (key, value) VALUES ('delivery_fee', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [fee.toFixed(2)]);
    res.json({ deliveryFee: fee, freeShippingThreshold: FREE_SHIPPING_THRESHOLD });
  } catch (error) {
    console.error("Could not save delivery fee:", error);
    res.status(503).json({ error: "Could not save the delivery fee. Check the database connection and permissions, then try again." });
  }
});

adminRouter.post("/products", async (req, res) => {
  try {
    const product = validateProduct(req.body);
    const result = await pool.query("INSERT INTO products (id, name, price, description, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, price, description, image_url", [product.id, product.name, product.price, product.description, product.image_url]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(error.code === "23505" ? 409 : 400).json({ error: error.code === "23505" ? "That product ID already exists." : error.message });
  }
});

adminRouter.put("/products/:productId", async (req, res) => {
  try {
    const product = validateProduct({ ...req.body, id: req.params.productId });
    const result = await pool.query("UPDATE products SET name = $2, price = $3, description = $4, image_url = $5 WHERE id = $1 RETURNING id, name, price, description, image_url", [product.id, product.name, product.price, product.description, product.image_url]);
    if (!result.rowCount) return res.status(404).json({ error: "Product not found." });
    res.json(result.rows[0]);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

adminRouter.delete("/products/:productId", async (req, res) => {
  await pool.query("DELETE FROM cart_items WHERE product_id = $1", [req.params.productId]);
  const result = await pool.query("DELETE FROM products WHERE id = $1 RETURNING id", [req.params.productId]);
  if (!result.rowCount) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true });
});

adminRouter.get("/orders", async (req, res) => {
  const status = req.query.status || null;
  const validStatuses = ["new", "confirmed", "processing", "shipped", "delivered", "cancelled"];
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: "Invalid order status filter." });
  const result = await pool.query(`SELECT o.id, o.created_at, o.customer_name, o.customer_phone, o.customer_email,
    o.delivery_address, o.delivery_city, o.delivery_postal_code, o.payment_method, o.payment_status,
    o.status, o.note, o.subtotal, o.shipping, o.total,
    COALESCE(json_agg(json_build_object('id', i.product_id, 'name', i.product_name, 'price', i.unit_price, 'quantity', i.quantity, 'lineTotal', i.line_total) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
    FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
    WHERE ($1::varchar IS NULL OR o.status = $1)
    GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`, [status]);
  res.json(result.rows);
});

adminRouter.patch("/orders/:orderId", async (req, res) => {
  try {
    const status = req.body?.status === undefined ? null : req.body.status;
    const paymentStatus = req.body?.payment_status === undefined ? null : req.body.payment_status;
    if (status !== null && !["new", "confirmed", "processing", "shipped", "delivered", "cancelled"].includes(status)) throw new Error("Invalid order status.");
    if (paymentStatus !== null && !["pending", "paid", "due_on_delivery", "refunded"].includes(paymentStatus)) throw new Error("Invalid payment status.");
    if (status === null && paymentStatus === null) throw new Error("Choose an order or payment status to update.");
    const result = await pool.query("UPDATE orders SET status = COALESCE($2, status), payment_status = COALESCE($3, payment_status) WHERE id = $1 RETURNING id, status, payment_status", [req.params.orderId, status, paymentStatus]);
    if (!result.rowCount) return res.status(404).json({ error: "Order not found." });
    res.json(result.rows[0]);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.use("/api/admin", adminRouter);

app.post("/api/orders", async (req, res) => {
  try {
    const cartId = await getCartId(req, res);
    const order = await createOrder(req.body, cartId);
    const emailSent = await sendOrderEmails(order);
    res.status(201).json({ ok: true, emailSent, order: { id: order.id, total: order.total } });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.use("/api", (req, res) => {
  res.status(req.method === "GET" || req.method === "HEAD" ? 404 : 405).json({ error: req.method === "GET" || req.method === "HEAD" ? "Not found" : "Method not allowed" });
});

app.use(express.static(PUBLIC));
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status === 400 || error.status === 413 ? error.status : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 413 ? "Request body is too large." : status === 400 ? "Invalid JSON request body." : "Something went wrong." });
});

app.listen(PORT, () => console.log(`Nutikals is running at http://localhost:${PORT}`));
