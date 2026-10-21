# Deployment

Upload the contents of `backend/` to `/home/nido/nutikals-api`, outside the web root. In cPanel, use **Setup Node.js App** with:

- Application root: `nutikals-api`
- Application URL: `nutikals.com` with path `demo/api`
- Startup file: `server.js`

Copy `backend/.env.example` to `backend/.env` on the server and set the database, admin, and mail values there. Configure Node 22, then run **NPM Install** and **Restart** in Setup Node.js App.

Before restarting the updated backend, apply `backend/db/migrations/006_order_email_delivery.sql` to the same PostgreSQL database used by the app. The migration is safe to rerun. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`, `MAIL_ADMIN_TO`, and `SITE_URL`; `MAIL_FROM` must be the sender address allowed by your SMTP provider. If any setting is missing or invalid, the app logs one startup warning and skips mail delivery.

To check SMTP from cPanel without shell access, run `npm run mail:test` with the **Run JS script** button. It verifies the SMTP connection and sends a test message to `MAIL_ADMIN_TO`. New orders send customer and admin messages after the order transaction commits. Failed deliveries are retried at startup and every 10 minutes for orders from the last 24 hours, up to three delivery attempts per order.

Upload the contents of `frontend/` to the web folder that serves `https://nutikals.com/demo/`. Keep the backend directory outside that web folder. Set `UPLOAD_DIR` in the backend environment to the absolute filesystem path of `frontend/uploads` under the web folder, and make that directory writable by the Node application for admin image uploads.
