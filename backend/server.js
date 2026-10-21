const express = require("express");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const pool = require("./db");
const productDetails = require("./products");
const mailer = require("./mailer");
const siteContent = require("./site-content");

const FRONTEND_ROOT = path.join(__dirname, "..", "frontend");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(FRONTEND_ROOT, "uploads");
const CART_COOKIE = "nutikals_cart";
const CART_SECRET = process.env.CART_COOKIE_SECRET || "";
const FREE_SHIPPING_THRESHOLD = 5000;
let storeSettingsReady;
let siteContentReady;
let productContentReady;

async function ensureProductContent() {
  if (!productContentReady) {
    productContentReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS product_content (
        product_id varchar(40) PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        subtitle varchar(500) NOT NULL DEFAULT '', size varchar(100) NOT NULL DEFAULT '',
        gallery jsonb NOT NULL DEFAULT '[]'::jsonb, eyebrow varchar(200) NOT NULL DEFAULT '',
        intro varchar(2000) NOT NULL DEFAULT '', notes jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      for (const product of productDetails) await pool.query(`INSERT INTO product_content (product_id, subtitle, size, gallery, eyebrow, intro, notes)
        SELECT $1::varchar(40),$2,$3,$4::jsonb,$5,$6,$7::jsonb WHERE EXISTS (SELECT 1 FROM products WHERE id=$1::varchar(40))
        ON CONFLICT (product_id) DO NOTHING`, [product.id, product.subtitle || "", product.size || "", JSON.stringify(product.gallery || []), product.eyebrow || "", product.intro || "", JSON.stringify(product.notes || [])]);
    })().catch(error => { productContentReady = null; throw error; });
  }
  return productContentReady;
}

async function ensureSiteContent() {
  if (!siteContentReady) {
    siteContentReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS site_content (
        content_key varchar(80) PRIMARY KEY,
        content_value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      const entries = Object.entries(siteContent.fields);
      await pool.query(`INSERT INTO site_content (content_key,content_value)
        SELECT * FROM unnest($1::varchar[], $2::text[]) ON CONFLICT (content_key) DO NOTHING`, [entries.map(([key]) => key), entries.map(([, value]) => value)]);
    })().catch(error => { siteContentReady = null; throw error; });
  }
  return siteContentReady;
}

async function readSiteContent() {
  await ensureSiteContent();
  const result = await pool.query("SELECT content_key, content_value FROM site_content");
  return { ...siteContent.fields, ...Object.fromEntries(result.rows.map(row => [row.content_key, row.content_value])) };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
  if (!name || !description || !imageUrl || !isLocalOrHttpUrl(imageUrl) || !Number.isFinite(price) || price <= 0) throw new Error("Provide a name, positive price, description, and a local or HTTP(S) image URL.");
  const gallery = body.gallery === undefined ? undefined : normalizeProductList(body.gallery, 12, 1000, "gallery image");
  const notes = body.notes === undefined ? undefined : normalizeProductList(body.notes, 12, 300, "product note");
  const extra = {};
  for (const [key, max] of Object.entries({ subtitle: 500, size: 100, eyebrow: 200, intro: 2000 })) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || body[key].trim().length > max) throw new Error(`Invalid ${key}.`);
      extra[key] = body[key].trim();
    }
  }
  if (gallery !== undefined) extra.gallery = gallery;
  if (notes !== undefined) extra.notes = notes;
  return { id, name, price, description, image_url: imageUrl, ...extra };
}

function isLocalOrHttpUrl(value) {
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function normalizeProductList(value, maxItems, maxLength, label) {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== "string" || !item.trim() || item.trim().length > maxLength)) throw new Error(`Provide up to ${maxItems} valid ${label}s.`);
  const items = value.map(item => item.trim());
  if (label === "gallery image" && items.some(item => !isLocalOrHttpUrl(item))) throw new Error("Gallery images must use a local path or HTTP(S) URL.");
  return items;
}

function presentProduct(row) {
  const details = productDetails.find(item => item.id === row.id) || {};
  const saved = row.product_content || {};
  const hasSavedContent = saved.subtitle !== null && saved.subtitle !== undefined;
  return {
    ...details,
    id: row.id,
    name: row.name,
    price: Number(row.price),
    description: row.description,
    image: row.image_url,
    subtitle: saved.subtitle ?? details.subtitle ?? "",
    size: saved.size ?? details.size ?? "",
    gallery: hasSavedContent ? saved.gallery : details.gallery || [row.image_url],
    eyebrow: saved.eyebrow ?? details.eyebrow ?? "",
    intro: saved.intro || details.intro || row.description,
    notes: hasSavedContent ? saved.notes : details.notes || []
  };
}

async function saveProductContent(product, preserveExisting = false) {
  const legacy = productDetails.find(item => item.id === product.id) || {};
  await ensureProductContent();
  const saved = preserveExisting
    ? (await pool.query("SELECT subtitle, size, gallery, eyebrow, intro, notes FROM product_content WHERE product_id = $1", [product.id])).rows[0] || {}
    : {};
  const value = {
    subtitle: product.subtitle ?? saved.subtitle ?? legacy.subtitle ?? "",
    size: product.size ?? saved.size ?? legacy.size ?? "",
    gallery: product.gallery ?? saved.gallery ?? legacy.gallery ?? [product.image_url],
    eyebrow: product.eyebrow ?? saved.eyebrow ?? legacy.eyebrow ?? "",
    intro: product.intro ?? saved.intro ?? legacy.intro ?? product.description,
    notes: product.notes ?? saved.notes ?? legacy.notes ?? []
  };
  await pool.query(`INSERT INTO product_content (product_id,subtitle,size,gallery,eyebrow,intro,notes,updated_at)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,now()) ON CONFLICT (product_id) DO UPDATE SET
    subtitle=EXCLUDED.subtitle,size=EXCLUDED.size,gallery=EXCLUDED.gallery,eyebrow=EXCLUDED.eyebrow,
    intro=EXCLUDED.intro,notes=EXCLUDED.notes,updated_at=now()`, [product.id, value.subtitle, value.size, JSON.stringify(value.gallery), value.eyebrow, value.intro, JSON.stringify(value.notes)]);
}

function signCartId(id) {
  return crypto.createHmac("sha256", CART_SECRET).update(id).digest("hex");
}

function signCheckoutAttempt(cartId, key) {
  return crypto.createHmac("sha256", CART_SECRET).update(`checkout:${cartId}:${key}`).digest("hex");
}

function checkoutAttemptKey(req, cartId) {
  const value = req.get("Idempotency-Key") || "";
  const match = value.match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([a-f0-9]{64})$/i);
  if (!match) {
    console.error("Checkout attempt rejected: missing or malformed signed key.");
    throw new HttpError(400, "A valid checkout attempt key is required. Refresh checkout and try again.");
  }
  const expected = Buffer.from(signCheckoutAttempt(cartId, match[1]), "hex");
  const actual = Buffer.from(match[2], "hex");
  if (!crypto.timingSafeEqual(expected, actual)) {
    console.error("Checkout attempt rejected: key signature invalid or bound to another cart.");
    throw new HttpError(400, "A valid checkout attempt key is required. Refresh checkout and try again.");
  }
  return match[1];
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

function normalizeOrderRequest(body = {}, cartId, idempotencyKey) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Invalid checkout request.");
  const customer = body?.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) throw new HttpError(400, "Please complete every checkout field.");
  const fields = [customer.name, customer.phone, customer.address, customer.city, customer.postalCode, body.note];
  if (fields.some(value => typeof value !== "string")) throw new HttpError(400, "Please complete every checkout field.");
  const normalized = {
    customer: {
      name: clean(customer.name, 100),
      phone: clean(customer.phone, 40),
      address: clean(customer.address, 500),
      city: clean(customer.city, 100),
      postalCode: clean(customer.postalCode, 20),
      email: mailer.validEmail(clean(customer.email, 120)) ? clean(customer.email, 120) : ""
    },
    note: clean(body.note, 300),
    paymentMethod: body.paymentMethod
  };
  if (Object.values(normalized.customer).some(value => !value) || !normalized.note || !["cash_on_delivery", "jazzcash"].includes(normalized.paymentMethod)) {
    throw new HttpError(400, "Please complete every checkout field.");
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 12) throw new HttpError(400, "Your cart is empty or invalid.");
  normalized.items = body.items.map(line => ({ id: clean(line?.id, 40), quantity: Number(line?.quantity) }));
  if (normalized.items.some(line => !line.id || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10) || new Set(normalized.items.map(line => line.id)).size !== normalized.items.length) {
    throw new HttpError(400, "A product or quantity in your cart is invalid.");
  }
  normalized.items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  normalized.requestHash = crypto.createHash("sha256").update(JSON.stringify({ cartId, ...normalized })).digest("hex");
  return normalized;
}

async function findIdempotentOrder(db, idempotencyKey, requestHash) {
  const result = await db.query("SELECT id, total, email_sent, request_hash FROM orders WHERE idempotency_key = $1", [idempotencyKey]);
  if (!result.rowCount) return null;
  const existing = result.rows[0];
  if (existing.request_hash !== requestHash) throw new HttpError(409, "This checkout attempt was already used with different details. Start a new checkout attempt.");
  return { id: existing.id, total: Number(existing.total), emailSent: Boolean(existing.email_sent), replayed: true };
}

const activeEmailJobs = new Set();

async function deliverOrderEmails(orderId, providedOrder) {
  if (!mailer.config || activeEmailJobs.has(orderId)) return;
  activeEmailJobs.add(orderId);
  try {
    let order = providedOrder;
    if (!order) {
      const result = await pool.query(`SELECT id, customer_name, customer_phone, customer_email, delivery_address,
        delivery_city, delivery_postal_code, payment_method, subtotal, shipping, total,
        customer_email_sent_at, admin_email_sent_at FROM orders WHERE id = $1`, [orderId]);
      if (!result.rowCount) return;
      const row = result.rows[0];
      const items = await pool.query("SELECT product_name AS name, unit_price AS price, quantity, line_total AS \"lineTotal\" FROM order_items WHERE order_id = $1 ORDER BY id", [orderId]);
      order = {
        id: row.id, customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email || "", address: row.delivery_address, city: row.delivery_city, postalCode: row.delivery_postal_code || "" },
        paymentMethod: row.payment_method, subtotal: Number(row.subtotal), shipping: Number(row.shipping), total: Number(row.total), items: items.rows,
        customerEmailSentAt: row.customer_email_sent_at, adminEmailSentAt: row.admin_email_sent_at
      };
    }
    const claimed = await pool.query(`UPDATE orders SET email_attempts = email_attempts + 1
      WHERE id = $1 AND email_attempts < 3 AND (customer_email_sent_at IS NULL OR admin_email_sent_at IS NULL)
      RETURNING email_attempts`, [orderId]);
    if (!claimed.rowCount) return;
    const result = await mailer.sendOrderEmails(order);
    const updates = [];
    if (result.customerSent) updates.push("customer_email_sent_at = now()");
    if (result.adminSent) updates.push("admin_email_sent_at = now()");
    if (updates.length) {
      const fullySent = (order.customer.email ? result.customerSent || Boolean(order.customerEmailSentAt) : false) && (result.adminSent || Boolean(order.adminEmailSentAt));
      updates.push(`email_sent = ${fullySent ? "true" : "false"}`);
      await pool.query(`UPDATE orders SET ${updates.join(", ")} WHERE id = $1`, [orderId]);
    }
    for (const error of result.errors) console.error(`Order email failed for ${orderId}: ${error.code || "SMTP_ERROR"}`);
  } catch (error) {
    console.error(`Order email failed for ${orderId}: ${error.code || "MAIL_ERROR"}`);
  } finally {
    activeEmailJobs.delete(orderId);
  }
}

async function retryRecentOrderEmails() {
  if (!mailer.config) return;
  try {
    const pending = await pool.query(`SELECT id FROM orders
      WHERE created_at >= now() - interval '24 hours' AND email_attempts < 3
        AND (customer_email_sent_at IS NULL OR admin_email_sent_at IS NULL)
      ORDER BY created_at`);
    for (const row of pending.rows) await deliverOrderEmails(row.id);
  } catch (error) {
    console.error(`Order email retry scan failed: ${error.code || "DATABASE_ERROR"}`);
  }
}

async function createOrder(body = {}, cartId, idempotencyKey) {
  const request = normalizeOrderRequest(body, cartId, idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await client.query("SELECT id FROM cart_sessions WHERE id = $1 FOR UPDATE", [cartId]);
    if (!session.rowCount) throw new HttpError(400, "Your cart has expired. Refresh the page and try again.");
    const existingOrder = await findIdempotentOrder(client, idempotencyKey, request.requestHash);
    if (existingOrder) {
      await client.query("COMMIT");
      return existingOrder;
    }
    const cartResult = await client.query("SELECT product_id AS id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY product_id FOR UPDATE", [cartId]);
    const requestedItems = cartResult.rows;
    if (!requestedItems.length || requestedItems.length > 12) throw new HttpError(400, "Your cart is empty or invalid.");
    const storedItems = requestedItems.map(line => ({ id: line.id, quantity: Number(line.quantity) }));
    if (JSON.stringify(storedItems) !== JSON.stringify(request.items)) throw new HttpError(409, "Your cart changed. Refresh checkout and try again.");
    const productResult = await client.query("SELECT id, name, price FROM products WHERE id = ANY($1::varchar[])", [requestedItems.map(line => line.id)]);
    const items = requestedItems.map(line => {
      const product = productResult.rows.find(item => item.id === line.id);
      if (!product) throw new HttpError(400, "A product or quantity in your cart is invalid.");
      const price = Number(product.price);
      return { id: product.id, name: product.name, price, quantity: line.quantity, lineTotal: price * line.quantity };
    });
    const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const deliveryFee = await getDeliveryFee(client);
    const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : deliveryFee;
    const paymentMethod = request.paymentMethod === "jazzcash" ? "jazzcash_manual" : "cash_on_delivery";
    const order = {
      id: `NK-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      createdAt: new Date().toISOString(),
      customer: request.customer,
      items,
      subtotal,
      shipping,
      total: subtotal + shipping,
      emailSent: false,
      paymentMethod,
      paymentStatus: paymentMethod === "cash_on_delivery" ? "due_on_delivery" : "pending",
      note: request.note,
      status: "new"
    };
    await client.query(`INSERT INTO orders
      (id, created_at, customer_name, customer_phone, customer_email, delivery_address, delivery_city, delivery_postal_code, payment_method, payment_status, status, note, subtotal, shipping, total, idempotency_key, request_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [order.id, order.createdAt, request.customer.name, request.customer.phone, request.customer.email, request.customer.address, request.customer.city, request.customer.postalCode, paymentMethod, order.paymentStatus, order.status, order.note, subtotal, shipping, order.total, idempotencyKey, request.requestHash]);
    for (const item of items) {
      await client.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total) VALUES ($1,$2,$3,$4,$5,$6)", [order.id, item.id, item.name, item.price, item.quantity, item.lineTotal]);
    }
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    await client.query("COMMIT");
    return { ...order, replayed: false };
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { console.error("Order transaction rollback failed:", rollbackError); }
    if (error.constraint === "orders_idempotency_key_uidx") {
      const replay = await findIdempotentOrder(pool, idempotencyKey, request.requestHash);
      if (replay) return replay;
    }
    throw error;
  } finally { client.release(); }
}

const app = express();
const api = express.Router();
const BASE_PATH = process.env.API_BASE_PATH || "/demo/api";
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.originalUrl.startsWith(BASE_PATH)) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "20kb" }));

api.get("/products", async (req, res) => {
  await ensureProductContent();
  const result = await pool.query(`SELECT p.id,p.name,p.price,p.description,p.image_url,
    json_build_object('subtitle',c.subtitle,'size',c.size,'gallery',c.gallery,'eyebrow',c.eyebrow,'intro',c.intro,'notes',c.notes) AS product_content
    FROM products p LEFT JOIN product_content c ON c.product_id=p.id ORDER BY p.id`);
  res.json(result.rows.map(presentProduct));
});

api.get("/site-content", async (req, res) => {
  try { res.json(await readSiteContent()); }
  catch (error) { console.error("Could not load site content:", error); res.status(503).json({ error: "Website content is temporarily unavailable." }); }
});

api.get("/store-settings", async (req, res) => {
  try { res.json({ deliveryFee: await getDeliveryFee(), freeShippingThreshold: FREE_SHIPPING_THRESHOLD }); }
  catch (error) { console.error("Could not load store settings:", error); res.status(503).json({ error: "Delivery pricing is temporarily unavailable. Please try again shortly." }); }
});

api.get("/cart", async (req, res) => {
  const cartId = await getCartId(req, res);
  const result = await pool.query("SELECT product_id AS id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY product_id", [cartId]);
  res.json({ items: result.rows });
});

api.post("/checkout-attempt", async (req, res) => {
  try {
    const cartId = await getCartId(req, res);
    const key = req.body?.key;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key || "")) {
      console.error("Checkout attempt key issue rejected: missing or malformed UUID.");
      throw new HttpError(400, "A valid checkout attempt key is required. Refresh checkout and try again.");
    }
    res.json({ key: `${key}.${signCheckoutAttempt(cartId, key)}` });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Checkout attempt key issue failed:", error);
    res.status(status).json({ ok: false, error: status >= 500 ? "Checkout is temporarily unavailable. Please try again." : error.message });
  }
});

api.put("/cart", async (req, res) => {
  try {
    const cartId = await getCartId(req, res);
    const items = await updateCart(cartId, req.body?.items);
    res.json({ ok: true, items });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.post("/uploads", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }), async (req, res) => {
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return res.status(400).json({ error: "Upload a JPEG, PNG, or WebP image up to 5 MB." });
  let extension;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    const hasFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].some(marker => bytes.indexOf(Buffer.from([0xff, marker]), 2) >= 0);
    if (hasFrame && bytes.indexOf(Buffer.from([0xff, 0xda]), 2) >= 0) extension = ".jpg";
  } else if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    ) && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND") extension = ".png";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8) extension = ".webp";
  if (!extension) return res.status(415).json({ error: "The uploaded file content is not a supported JPEG, PNG, or WebP image." });
  const expectedExtension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[req.get("Content-Type")];
  if (expectedExtension !== extension) return res.status(415).json({ error: "The image content does not match its declared file type." });
  const filename = `${crypto.randomUUID()}${extension}`;
  const uploadDirectory = UPLOAD_DIR;
  try {
    await fs.mkdir(uploadDirectory, { recursive: true });
    await fs.writeFile(path.join(uploadDirectory, filename), bytes, { flag: "wx", mode: 0o644 });
    res.status(201).json({ url: `/uploads/${filename}` });
  } catch (error) {
    console.error("Could not store uploaded image:", error);
    res.status(503).json({ error: "Could not store the image. Check that the site's upload directory is writable and persistent." });
  }
});

adminRouter.get("/site-content", async (req, res) => {
  try { res.json(await readSiteContent()); }
  catch (error) { console.error("Could not load site content:", error); res.status(503).json({ error: "Could not load website content." }); }
});

adminRouter.put("/site-content", async (req, res) => {
  const values = req.body;
  if (!values || typeof values !== "object" || Array.isArray(values) || Buffer.byteLength(JSON.stringify(values), "utf8") > 12000) return res.status(400).json({ error: "Invalid or oversized content payload." });
  const keys = Object.keys(values);
  if (!keys.length || keys.some(key => !Object.hasOwn(siteContent.fields, key))) return res.status(400).json({ error: "Unknown content field." });
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.trim().length > siteContent.limits[key] || /[\u0000]/.test(value) || (siteContent.urls.has(key) && !siteContent.validUrl(value.trim()))) return res.status(400).json({ error: `Invalid value for ${key}.` });
  }
  try {
    await ensureSiteContent();
    for (const [key, value] of Object.entries(values)) await pool.query("INSERT INTO site_content (content_key, content_value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (content_key) DO UPDATE SET content_value = EXCLUDED.content_value, updated_at = now()", [key, value.trim()]);
    res.json(await readSiteContent());
  } catch (error) { console.error("Could not save site content:", error); res.status(503).json({ error: "Could not save website content." }); }
});

adminRouter.get("/products", async (req, res) => {
  await ensureProductContent();
  const result = await pool.query(`SELECT p.id,p.name,p.price,p.description,p.image_url,
    json_build_object('subtitle',c.subtitle,'size',c.size,'gallery',c.gallery,'eyebrow',c.eyebrow,'intro',c.intro,'notes',c.notes) AS product_content
    FROM products p LEFT JOIN product_content c ON c.product_id=p.id ORDER BY p.id`);
  res.json(result.rows.map(product => ({ ...product, ...(product.product_content?.subtitle === null ? {} : product.product_content) })));
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
    await saveProductContent(product);
    res.status(201).json({ ...result.rows[0], ...presentProduct({ ...result.rows[0], product_content: product }) });
  } catch (error) {
    res.status(error.code === "23505" ? 409 : 400).json({ error: error.code === "23505" ? "That product ID already exists." : error.message });
  }
});

adminRouter.put("/products/:productId", async (req, res) => {
  try {
    const product = validateProduct({ ...req.body, id: req.params.productId });
    const result = await pool.query("UPDATE products SET name = $2, price = $3, description = $4, image_url = $5 WHERE id = $1 RETURNING id, name, price, description, image_url", [product.id, product.name, product.price, product.description, product.image_url]);
    if (!result.rowCount) return res.status(404).json({ error: "Product not found." });
    await saveProductContent(product, true);
    res.json({ ...result.rows[0], ...presentProduct({ ...result.rows[0], product_content: product }) });
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

api.use("/admin", adminRouter);

api.post("/orders", async (req, res) => {
  try {
    const cartId = await getCartId(req, res);
    const order = await createOrder(req.body, cartId, checkoutAttemptKey(req, cartId));
    if (order.replayed) return res.status(201).json({ ok: true, emailSent: order.emailSent, order: { id: order.id, total: order.total } });
    try { void deliverOrderEmails(order.id, order); }
    catch (error) { console.error(`Order email failed for ${order.id}: ${error.code || "MAIL_ERROR"}`); }
    res.status(201).json({ ok: true, emailSent: false, order: { id: order.id, total: order.total } });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Order creation failed:", error);
    res.status(status).json({ ok: false, error: status >= 500 ? "We couldn't process your order right now. Retry this checkout attempt shortly." : error.message });
  }
});

api.get("/ping", (req, res) => res.json({ ok: true }));

api.use((req, res) => {
  res.status(req.method === "GET" || req.method === "HEAD" ? 404 : 405).json({ error: req.method === "GET" || req.method === "HEAD" ? "Not found" : "Method not allowed" });
});
api.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status === 400 || error.status === 413 ? error.status : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 413 ? "Request body is too large." : status === 400 ? "Invalid JSON request body." : "Something went wrong." });
});
app.use(BASE_PATH, api);

const emailRetryTimer = setInterval(() => { void retryRecentOrderEmails(); }, 10 * 60 * 1000);
emailRetryTimer.unref();
app.listen(process.env.PORT || 3000, () => {
  console.log("Nutikals API is running.");
  void retryRecentOrderEmails();
});
