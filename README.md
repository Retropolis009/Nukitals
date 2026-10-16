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

The public catalog and admin product editor use the `products` table with `id`, `name`, `price`, `description`, and `image_url` columns. Admin users can add, edit, and delete products. Existing product copy and gallery details are still supplied by `products.js` where the database schema has no corresponding fields.

Run the SQL in `db/migrations/001_guest_carts.sql` once against the database to create guest cart tables. Guest carts are tied to an HTTP-only browser cookie and last 90 days; they do not sync across devices. Set `CART_COOKIE_SECRET` to a long random value (the app falls back to `DB_PASSWORD` if it is unset).

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, and `EMAIL_TO` for order emails. The store inbox receives a message for every order, and the customer receives a confirmation at the required checkout email address. JazzCash remains a manual transfer; emails say to verify it separately. Email delivery errors are logged and do not cancel an order.

The admin API uses HTTP Basic credentials over HTTPS in production. Do not expose the admin route over plain HTTP on a public network.

Run `db/migrations/002_orders.sql` once against the database to create `orders` and `order_items`, then apply `db/migrations/004_order_idempotency.sql` before deploying the idempotent checkout update. Store settings are created automatically the first time the app reads or saves delivery pricing; `db/migrations/003_store_settings.sql` is also available for migration-managed deployments. The dashboard includes recent orders, customer and delivery details, line items, controls for order and payment status, and a delivery fee setting.

## Store behavior

- Product names, prices, descriptions, and image paths are loaded from PostgreSQL. Extra product presentation details for the original products remain in `products.js`.
- The server stores guest carts in PostgreSQL; the browser keeps a local cache to restore the bag if the cart API is temporarily unavailable.
- Checkout supports cash on delivery and manual JazzCash instructions. It does not process card details or verify JazzCash transfers.
- Orders and order items are stored in PostgreSQL.
- Prices are checked against the PostgreSQL catalog when an order is placed.
- Delivery costs Rs. 350 by default below Rs. 5,000 and is free at Rs. 5,000 and above. Admins can change the delivery fee in the dashboard.
- JazzCash checkout records a manual payment request to 0330 8348288. It does not initiate or confirm a transfer.
- Use HTTPS and set privacy and retention policies before launch.

The product gallery uses the supplied local image first and includes the remaining image links from the CSV as optional gallery items. A missing remote image is hidden automatically.

## Tests

Run `npm test` with `.env` configured for a local PostgreSQL server. The checkout integration tests create a uniquely named temporary schema, run the migrations and fixtures inside it, start an isolated test server, then drop the schema. They refuse to create test data when PostgreSQL reports a non-local connection.
