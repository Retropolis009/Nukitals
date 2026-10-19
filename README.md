# Nutikals storefront

A small HTML, CSS and JavaScript storefront served by an Express 5 app on Node.js, with a PostgreSQL product catalog and the three supplied image files.

## Run locally

Install Node.js 18 or newer, install dependencies, then run:

```sh
npm install
npm start
```

Open `http://localhost:3000`.

## PostgreSQL and admin

Copy `.env.example` to `.env` and set the PostgreSQL connection values and a long, unique `ADMIN_PASSWORD`. The `.env` file is ignored by Git. Start the app with `npm start`, then open `http://localhost:3000/admin` and sign in with `ADMIN_USER` and `ADMIN_PASSWORD`.

The public catalog and admin product editor use the `products` table with `id`, `name`, `price`, `description`, and `image_url` columns. Product presentation fields are stored by product ID in `product_content`, so existing product identities and pricing remain the source of truth.

Run the SQL in `db/migrations/001_guest_carts.sql` once against the database to create guest cart tables. Guest carts are tied to an HTTP-only browser cookie and last 90 days; they do not sync across devices. Set `CART_COOKIE_SECRET` to a long random value (the app falls back to `DB_PASSWORD` if it is unset).

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, and `EMAIL_TO` for order emails. The store inbox receives a message for every order, and the customer receives a confirmation at the required checkout email address. JazzCash remains a manual transfer; emails say to verify it separately. Email delivery errors are logged and do not cancel an order.

The admin API uses HTTP Basic credentials over HTTPS in production. Do not expose the admin route over plain HTTP on a public network.

Run `db/migrations/002_orders.sql` once against the database to create `orders` and `order_items`, then apply `db/migrations/004_order_idempotency.sql` before deploying the idempotent checkout update. Apply `db/migrations/005_content_editor.sql` for migration-managed deployments. The app also creates the content tables safely on first use and seeds defaults with conflict-safe inserts; it never replaces existing saved content. Store settings are created automatically the first time the app reads or saves delivery pricing; `db/migrations/003_store_settings.sql` is also available. The dashboard includes recent orders, customer and delivery details, line items, controls for order and payment status, and a separate delivery fee setting.

## Editing the website

Sign in at `/admin` and use the **Website Content** tab for marketing text and links. Edit fields and choose **Save website content**; use **Reload saved content** to discard unsaved edits and load the stored values again. Text appears on the storefront and checkout without editing source files.

The Website Content editor covers the announcement and homepage hero buttons, featured and brand-story headings, hair/skin/beard descriptions, delivery timing and free-shipping messages, homepage payment and confirmation text, checkout payment/confirmation guidance, three review quotes and names, footer tagline, and WhatsApp/Facebook/Instagram destinations. Use `{threshold}` in the announcement to show the live free-shipping threshold, and `{amount}` in the cart progress message for the remaining amount. The threshold and delivery fee shown to customers are read from trusted store settings; content edits do not change order totals, payment instructions behavior, or checkout validation.

Use the **Products** tab to manage the landing-page catalog: product ID, name, price, description, and main image. The same main image is used by the product listing and featured carousel. Enter a local path such as `/images/product.jpg` or an HTTP(S) URL, or upload a JPEG, PNG, or WebP image up to 5 MB. The server checks the image content, generates a unique filename, and saves it under `uploads`; it never accepts a client-supplied path or overwrites a file. The host must retain that directory across deploys and allow the Node process to write to it. Uploaded files are public assets once stored; deleting products does not automatically delete images.

The Website Content editor has a live homepage preview beside the fields. Unsaved copy updates there while you type. The product form shows an image thumbnail, and an uploaded image is not published to the catalog until you save the product.

The public content endpoint is `GET /api/site-content`. Admin content endpoints are `GET /api/admin/site-content` and `PUT /api/admin/site-content`; they require the existing admin Basic authentication. Product presentation is returned with the existing `/api/products` response and saved through existing product admin routes.

## Store behavior

- Product names, prices, descriptions, and image paths are loaded from PostgreSQL. The storefront uses the landing page for product listings and cart additions; it has no separate product-detail page.
- The server stores guest carts in PostgreSQL; the browser keeps a local cache to restore the bag if the cart API is temporarily unavailable.
- Checkout supports cash on delivery and manual JazzCash instructions. It does not process card details or verify JazzCash transfers.
- Orders and order items are stored in PostgreSQL.
- Prices are checked against the PostgreSQL catalog when an order is placed.
- Delivery costs Rs. 350 by default below Rs. 5,000 and is free at Rs. 5,000 and above. Admins can change the delivery fee in the dashboard.
- JazzCash checkout records a manual payment request to 0330 8348288. It does not initiate or confirm a transfer.
- Use HTTPS and set privacy and retention policies before launch.

## Tests

Run `npm test` with `.env` configured for a local PostgreSQL server. The checkout integration tests create a uniquely named temporary schema, run the migrations and fixtures inside it, start an isolated test server, then drop the schema. They refuse to create test data when PostgreSQL reports a non-local connection.
