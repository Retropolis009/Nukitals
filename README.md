# Nutikals storefront

A small HTML, CSS and JavaScript storefront served by a built-in Node.js HTTP server, with a PostgreSQL product catalog and the three supplied image files.

## Run locally

Install Node.js 18 or newer, install dependencies, then run:

```sh
npm install
npm start
```

Open `http://localhost:3000`. No package installation is required.

## PostgreSQL and admin

Copy `.env.example` to `.env` and set the PostgreSQL connection values and a long, unique `ADMIN_PASSWORD`. The `.env` file is ignored by Git. Start the app with `npm start`, then open `http://localhost:3000/admin` and sign in with `ADMIN_USER` and `ADMIN_PASSWORD`.

The public catalog and admin product editor use the `products` table with `id`, `name`, `price`, `description`, and `image_url` columns. Admin users can add, edit, and delete products. Existing product copy and gallery details are still supplied by `products.js` where the database schema has no corresponding fields.

The admin API uses HTTP Basic credentials over HTTPS in production. Do not expose the admin route over plain HTTP on a public network. Orders still use the local JSONL file until an orders schema is added.

## Store behavior

- Product names, prices, descriptions, and image paths are loaded from PostgreSQL. Extra product presentation details for the original products remain in `products.js`.
- The cart is kept in the customer's browser using local storage.
- Checkout accepts cash on delivery only. It does not ask for or process card details.
- New orders are written one per line to `orders/orders.jsonl`. The file is created after the first order and is excluded from Git.
- Prices are checked against the PostgreSQL catalog when an order is placed.
- Shipping costs Rs. 350 below Rs. 5,000 and is free at Rs. 5,000 and above.
- JazzCash checkout records a manual payment request to 0330 8348288. It does not initiate or confirm a transfer.
- The checkout API is intended for local development. Before a public launch, add HTTPS, an order management process, privacy/retention controls, and any shipping or payment provider integrations you need.

The product gallery uses the supplied local image first and includes the remaining image links from the CSV as optional gallery items. A missing remote image is hidden automatically.
