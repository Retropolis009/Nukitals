# Nutikals storefront

A small HTML, CSS and JavaScript storefront served by a built-in Node.js HTTP server. It uses the product names, prices, and product copy from the WooCommerce export, plus the three image files supplied with it.

## Run locally

Install Node.js 18 or newer, then run:

```sh
npm start
```

Open `http://localhost:3000`. No package installation is required.

## Store behavior

- The catalog and product details are in `products.js`.
- The cart is kept in the customer's browser using local storage.
- Checkout accepts cash on delivery only. It does not ask for or process card details.
- New orders are written one per line to `orders/orders.jsonl`. The file is created after the first order and is excluded from Git.
- Prices are checked against the server catalog when an order is placed.
- Shipping costs Rs. 350 below Rs. 5,000 and is free at Rs. 5,000 and above.
- JazzCash checkout records a manual payment request to 0330 8348288. It does not initiate or confirm a transfer.
- The checkout API is intended for local development. Before a public launch, add HTTPS, an order management process, privacy/retention controls, and any shipping or payment provider integrations you need.

The product gallery uses the supplied local image first and includes the remaining image links from the CSV as optional gallery items. A missing remote image is hidden automatically.
