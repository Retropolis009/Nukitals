# Deployment

Upload the contents of `backend/` to `/home/nido/nutikals-api`, outside the web root. In cPanel, use **Setup Node.js App** with:

- Application root: `nutikals-api`
- Application URL: `nutikals.com` with path `demo/api`
- Startup file: `server.js`

Copy `backend/.env.example` to `backend/.env` on the server and set the database, admin, and email values there. Configure Node 22, then run **NPM Install** and **Restart** in Setup Node.js App.

Upload the contents of `frontend/` to the web folder that serves `https://nutikals.com/demo/`. Keep the backend directory outside that web folder. Set `UPLOAD_DIR` in the backend environment to the absolute filesystem path of `frontend/uploads` under the web folder, and make that directory writable by the Node application for admin image uploads.
