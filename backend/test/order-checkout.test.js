const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { before, after, test } = require("node:test");

const pool = require("../db");
let schema;
let port;
let server;
let serverOutput = "";
let serverError = "";
let serverExited = false;

async function queryInTestSchema(sql, values = []) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}, public`);
    return await client.query(sql, values);
  } finally { client.release(); }
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const selectedPort = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return selectedPort;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverExited) throw new Error(`Test server exited before becoming ready. ${serverError || serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/products`);
      if (response.ok) return;
    } catch { /* The local test server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not become ready. ${serverError || serverOutput}`);
}

before(async () => {
  const scope = await pool.query(`SELECT CASE
    WHEN inet_server_addr() IS NULL OR inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr() <<= inet '::1/128'
    THEN 'local' ELSE 'non-local' END AS connection_scope`);
  assert.equal(scope.rows[0].connection_scope, "local", "Refusing to create test data in a non-local PostgreSQL database.");

  schema = `nutikals_test_${crypto.randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE products (
      id varchar(40) PRIMARY KEY,
      name varchar(160) NOT NULL,
      price numeric(12, 2) NOT NULL CHECK (price > 0),
      description text NOT NULL DEFAULT '',
      image_url varchar(1000) NOT NULL DEFAULT ''
    )`);
    for (const migration of ["001_guest_carts.sql", "002_orders.sql", "003_store_settings.sql", "004_order_idempotency.sql"]) {
      await client.query(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", migration), "utf8"));
    }
    await client.query("INSERT INTO products (id, name, price) VALUES ('test-product', 'Local test product', 1000), ('db-fail', 'Database failure fixture', 100)");
    await client.query(`CREATE FUNCTION reject_test_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.product_id = 'db-fail' THEN RAISE EXCEPTION 'intentional isolated test failure' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END
    $$`);
    await client.query("CREATE TRIGGER reject_test_order_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION reject_test_order_item()");
  } finally { client.release(); }

  port = await freePort();
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      NUTIKALS_TEST_SCHEMA: schema,
      PORT: String(port),
      SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "", EMAIL_FROM: "", EMAIL_TO: ""
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.setEncoding("utf8").on("data", chunk => { serverOutput += chunk; });
  server.stderr.setEncoding("utf8").on("data", chunk => { serverError += chunk; });
  server.once("exit", () => { serverExited = true; });
  await waitForServer();
});

test("storefront shopping stays on the landing page and has no product detail route", async () => {
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /data-carousel-image/);
  assert.doesNotMatch(html, /product\.html/);

  const productPage = await fetch(`http://127.0.0.1:${port}/product.html`);
  assert.equal(productPage.status, 404);

  const appScript = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  assert.doesNotMatch(appScript, /product\.html|renderProduct|data-product-detail/);
});

after(async () => {
  if (server && !serverExited) {
    server.kill();
    await new Promise(resolve => server.once("exit", resolve));
  }
  if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

async function makeCart(productId = "test-product", quantity = 2) {
  const response = await fetch(`http://127.0.0.1:${port}/api/cart`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "The cart endpoint should issue an isolated test cookie.");
  const update = await fetch(`http://127.0.0.1:${port}/api/cart`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ items: [{ id: productId, quantity }] })
  });
  assert.equal(update.status, 200);
  const cartId = cookie.split("=", 2)[1].split(".", 1)[0];
  return { cookie, cartId };
}

function orderPayload(overrides = {}) {
  return {
    customer: {
      name: "Local Test Customer",
      phone: "0000000000",
      email: "test@example.com",
      address: "1 Local Test Road",
      city: "Testville",
      postalCode: "00000"
    },
    note: "LOCAL TEST ONLY",
    paymentMethod: "cash_on_delivery",
    items: [{ id: "test-product", quantity: 2 }],
    ...overrides
  };
}

test("site content and product descriptions are public, authenticated for editing, validated, and persistent", async () => {
  const publicResponse = await fetch(`http://127.0.0.1:${port}/api/site-content`);
  assert.equal(publicResponse.status, 200);
  const seeded = await publicResponse.json();
  assert.equal(seeded.hero_heading, "Where science\nmeets nature");

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/admin/site-content`);
  assert.equal(unauthenticated.status, 401);
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;
  assert.ok(adminUser && adminPassword, "Admin credentials must be configured to test admin routes.");
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const adminHeaders = { Authorization: authorization, "Content-Type": "application/json" };
  const update = await fetch(`http://127.0.0.1:${port}/api/admin/site-content`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ hero_description: "Saved in isolated test schema" })
  });
  assert.equal(update.status, 200);
  const reloaded = await (await fetch(`http://127.0.0.1:${port}/api/site-content`)).json();
  assert.equal(reloaded.hero_description, "Saved in isolated test schema");

  for (const invalid of [
    { unknown_key: "x" }, { announcement: 42 }, { whatsapp_url: "javascript:alert(1)" }, { hero_description: "x".repeat(1201) }
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/site-content`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(invalid) });
    assert.equal(response.status, 400);
  }
  const injection = await fetch(`http://127.0.0.1:${port}/api/admin/site-content`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ "announcement'); DROP TABLE products; --": "x" })
  });
  assert.equal(injection.status, 400);

  const rejectedUpload = await fetch(`http://127.0.0.1:${port}/api/admin/uploads`, {
    method: "POST", headers: { Authorization: authorization, "Content-Type": "image/png" }, body: Buffer.from("this is not a png image")
  });
  assert.equal(rejectedUpload.status, 415);
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/INcAAAAASUVORK5CYII=", "base64");
  let uploadedPath;
  try {
    const upload = await fetch(`http://127.0.0.1:${port}/api/admin/uploads`, {
      method: "POST", headers: { Authorization: authorization, "Content-Type": "image/png" }, body: onePixelPng
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    uploadedPath = path.join(__dirname, "..", uploaded.url.slice(1));
    const served = await fetch(`http://127.0.0.1:${port}${uploaded.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
  } finally { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); }

  const productSave = await fetch(`http://127.0.0.1:${port}/api/admin/products/test-product`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ id: "test-product", name: "Local test product", price: 1000, image_url: "/images/test.jpg", description: "Core description", subtitle: "Editable subtitle", size: "50 ml", gallery: ["/images/test.jpg", "https://example.com/test.jpg"], eyebrow: "TEST", intro: "Editable intro", notes: ["Editable note"] })
  });
  assert.equal(productSave.status, 200);
  const products = await (await fetch(`http://127.0.0.1:${port}/api/products`)).json();
  const product = products.find(item => item.id === "test-product");
  assert.equal(product.image, "/images/test.jpg");
  assert.equal(product.subtitle, "Editable subtitle");
  assert.deepEqual(product.gallery, ["/images/test.jpg", "https://example.com/test.jpg"]);
  assert.deepEqual(product.notes, ["Editable note"]);

  const basicUpdate = await fetch(`http://127.0.0.1:${port}/api/admin/products/test-product`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ name: "Local test product", price: 1000, image_url: "/images/carousel.jpg", description: "Updated description" })
  });
  assert.equal(basicUpdate.status, 200);
  const updatedProduct = (await (await fetch(`http://127.0.0.1:${port}/api/products`)).json()).find(item => item.id === "test-product");
  assert.equal(updatedProduct.image, "/images/carousel.jpg");
  assert.equal(updatedProduct.subtitle, "Editable subtitle");
  assert.deepEqual(updatedProduct.gallery, ["/images/test.jpg", "https://example.com/test.jpg"]);
  assert.deepEqual(updatedProduct.notes, ["Editable note"]);
});

async function submitOrder(cookie, key, payload) {
  return fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": key },
    body: JSON.stringify(payload)
  });
}

test("rejects invalid checkout input without creating an order", async () => {
  const { cookie, cartId } = await makeCart();
  const payload = orderPayload();
  delete payload.customer.email;
  const response = await submitOrder(cookie, crypto.randomUUID(), payload);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /complete every checkout field/i);
  const invalidQuantity = await submitOrder(cookie, crypto.randomUUID(), orderPayload({ items: [{ id: "test-product", quantity: 0 }] }));
  assert.equal(invalidQuantity.status, 400);
  assert.match((await invalidQuantity.json()).error, /product or quantity/i);
  const count = await queryInTestSchema("SELECT count(*)::int AS count FROM orders");
  assert.equal(count.rows[0].count, 0);
  const cartCount = await queryInTestSchema("SELECT count(*)::int AS count FROM cart_items WHERE cart_id = $1", [cartId]);
  assert.equal(cartCount.rows[0].count, 1);
});

test("concurrent and later retries return one original order", async () => {
  const { cookie, cartId } = await makeCart();
  const key = crypto.randomUUID();
  const payload = orderPayload();
  const [first, concurrent] = await Promise.all([
    submitOrder(cookie, key, payload),
    submitOrder(cookie, key, payload)
  ]);
  assert.equal(first.status, 201);
  assert.equal(concurrent.status, 201);
  const firstBody = await first.json();
  const concurrentBody = await concurrent.json();
  assert.deepEqual(concurrentBody, firstBody);
  assert.equal(firstBody.order.total, 2350);

  const laterRetry = await submitOrder(cookie, key, payload);
  assert.equal(laterRetry.status, 201);
  assert.deepEqual(await laterRetry.json(), firstBody);

  const orderCount = await queryInTestSchema("SELECT count(*)::int AS count FROM orders");
  const itemResult = await queryInTestSchema("SELECT quantity, unit_price, line_total FROM order_items WHERE order_id = $1", [firstBody.order.id]);
  const cartCount = await queryInTestSchema("SELECT count(*)::int AS count FROM cart_items WHERE cart_id = $1", [cartId]);
  assert.equal(orderCount.rows[0].count, 1);
  assert.equal(itemResult.rowCount, 1);
  assert.equal(Number(itemResult.rows[0].quantity), 2);
  assert.equal(Number(itemResult.rows[0].unit_price), 1000);
  assert.equal(Number(itemResult.rows[0].line_total), 2000);
  assert.equal(cartCount.rows[0].count, 0);

  const changedPayload = orderPayload({ note: "CHANGED TEST DETAILS" });
  const conflict = await submitOrder(cookie, key, changedPayload);
  assert.equal(conflict.status, 409);
  const finalCount = await queryInTestSchema("SELECT count(*)::int AS count FROM orders");
  assert.equal(finalCount.rows[0].count, 1);
});

test("database failures return 500 and roll back order and item writes", async () => {
  const { cookie, cartId } = await makeCart("db-fail", 1);
  const payload = orderPayload({ items: [{ id: "db-fail", quantity: 1 }] });
  const response = await submitOrder(cookie, crypto.randomUUID(), payload);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /retry this checkout attempt/i);
  const orderCount = await queryInTestSchema("SELECT count(*)::int AS count FROM orders");
  const itemCount = await queryInTestSchema("SELECT count(*)::int AS count FROM order_items");
  const cartCount = await queryInTestSchema("SELECT count(*)::int AS count FROM cart_items WHERE cart_id = $1", [cartId]);
  assert.equal(orderCount.rows[0].count, 1);
  assert.equal(itemCount.rows[0].count, 1);
  assert.equal(cartCount.rows[0].count, 1);
});
