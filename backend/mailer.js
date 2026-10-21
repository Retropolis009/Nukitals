const nodemailer = require("nodemailer");
const parseAddresses = require("nodemailer/lib/addressparser");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanHeader = value => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const validEmail = value => typeof value === "string" && EMAIL_RE.test(value.trim());

function parseFrom(value) {
  let normalized = String(value ?? "").trim();
  if (normalized.length >= 2 && ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'")))) {
    normalized = normalized.slice(1, -1).trim();
  }
  const entries = parseAddresses(normalized).filter(entry => entry.address && validEmail(entry.address));
  if (entries.length !== 1) return null;
  return { name: cleanHeader(entries[0].name), address: entries[0].address.trim() };
}

function configWarning(errors, prefix = "Order email disabled") {
  const details = Object.entries(errors).map(([name, reason]) => `${name}: ${reason}`);
  return details.length ? `${prefix}: ${details.join("; ")}.` : "";
}

function readConfig(env = process.env) {
  const fromInput = String(env.MAIL_FROM ?? "").trim();
  const adminInput = String(env.MAIL_ADMIN_TO ?? "").trim();
  const config = {
    host: String(env.SMTP_HOST ?? "").trim(),
    port: String(env.SMTP_PORT ?? "").trim(),
    secure: String(env.SMTP_SECURE ?? "").trim(),
    user: String(env.SMTP_USER ?? "").trim(),
    password: env.SMTP_PASSWORD,
    from: parseFrom(fromInput),
    adminTo: adminInput,
    siteUrl: String(env.SITE_URL ?? "").trim().replace(/\/+$/, "")
  };
  const errors = {};
  const required = {
    SMTP_HOST: config.host, SMTP_PORT: config.port, SMTP_SECURE: config.secure,
    SMTP_USER: config.user, SMTP_PASSWORD: config.password, MAIL_FROM: fromInput,
    MAIL_ADMIN_TO: adminInput, SITE_URL: config.siteUrl
  };
  for (const [name, value] of Object.entries(required)) if (value === undefined || value === "") errors[name] = "is missing or empty";
  if (config.port && !/^\d+$/.test(config.port)) errors.SMTP_PORT = "not a whole number";
  else if (config.port && (Number(config.port) < 1 || Number(config.port) > 65535)) errors.SMTP_PORT = "must be between 1 and 65535";
  if (config.secure && !["true", "false"].includes(config.secure.toLowerCase())) errors.SMTP_SECURE = "must be true or false";
  if (fromInput && !config.from) errors.MAIL_FROM = "no valid email address found";
  if (adminInput && /[\s"']/.test(adminInput)) errors.MAIL_ADMIN_TO = "contains whitespace or quotes";
  else if (adminInput && !validEmail(adminInput)) errors.MAIL_ADMIN_TO = "no valid email address found";
  if (config.host && /\s/.test(config.host)) errors.SMTP_HOST = "contains whitespace";
  if (config.siteUrl) {
    try {
      const url = new URL(config.siteUrl);
      if (!/^https?:$/.test(url.protocol)) errors.SITE_URL = "must be an HTTP(S) URL";
    } catch { errors.SITE_URL = "must be an HTTP(S) URL"; }
  }
  if (Object.keys(errors).length) return { config: null, errors, warning: configWarning(errors) };
  return { config, errors: {} };
}

function createTransport(config, transportOptions) {
  return nodemailer.createTransport(transportOptions || {
    host: config.host,
    port: Number(config.port),
    secure: config.secure.toLowerCase() === "true",
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
}

function makeOrderEmails(order, config) {
  const customer = order.customer;
  const itemsText = order.items.map(item => `${item.quantity} x ${item.name} — Rs. ${Number(item.price ?? item.unit_price).toLocaleString("en-PK")} (Rs. ${Number(item.lineTotal ?? item.line_total).toLocaleString("en-PK")})`).join("\n");
  const payment = order.paymentMethod === "jazzcash_manual" || order.paymentMethod === "jazzcash" ? "JazzCash (manual transfer)" : "Cash on delivery";
  const address = `${customer.address}, ${customer.city} ${customer.postalCode}`.trim();
  const summaryText = [
    `Order: ${order.id}`, "", "Items:", itemsText, "",
    `Subtotal: Rs. ${Number(order.subtotal).toLocaleString("en-PK")}`,
    `Delivery: Rs. ${Number(order.shipping).toLocaleString("en-PK")}`,
    `Total: Rs. ${Number(order.total).toLocaleString("en-PK")}`,
    `Payment: ${payment}`, `Delivery address: ${address}`
  ].join("\n");
  const itemRows = order.items.map(item => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">Rs. ${escapeHtml(Number(item.lineTotal ?? item.line_total).toLocaleString("en-PK"))}</td></tr>`).join("");
  const htmlSummary = `<h2 style="margin:0 0 12px">Order ${escapeHtml(order.id)}</h2><table style="border-collapse:collapse;width:100%">${itemRows}</table><p>Subtotal: Rs. ${escapeHtml(Number(order.subtotal).toLocaleString("en-PK"))}<br>Delivery: Rs. ${escapeHtml(Number(order.shipping).toLocaleString("en-PK"))}<br><strong>Total: Rs. ${escapeHtml(Number(order.total).toLocaleString("en-PK"))}</strong></p><p>Payment: ${escapeHtml(payment)}<br>Delivery address: ${escapeHtml(address)}</p>`;
  const customerText = `Thank you for your order.\n\n${summaryText}\n\nVisit ${config.siteUrl}`;
  const customerHtml = `<div style="font-family:Arial,sans-serif;color:#172b36;line-height:1.5;max-width:600px;margin:auto"><p>Thank you for your order.</p>${htmlSummary}<p><a href="${escapeHtml(config.siteUrl)}" style="color:#14566b">Visit Nutikals</a></p></div>`;
  const adminText = `${summaryText}\n\nCustomer: ${customer.name}\nPhone: ${customer.phone}\nEmail: ${customer.email || "not provided"}\n\nManage orders: ${config.siteUrl}/admin.html`;
  const adminHtml = `<div style="font-family:Arial,sans-serif;color:#172b36;line-height:1.5;max-width:600px;margin:auto">${htmlSummary}<p>Customer: ${escapeHtml(customer.name)}<br>Phone: ${escapeHtml(customer.phone)}<br>Email: ${escapeHtml(customer.email || "not provided")}</p><p><a href="${escapeHtml(config.siteUrl)}/admin.html" style="color:#14566b">Manage orders</a></p></div>`;
  const orderId = cleanHeader(order.id);
  return {
    customer: validEmail(customer.email) && !order.customerEmailSentAt ? {
      from: config.from, to: cleanHeader(customer.email), subject: cleanHeader(`Nutikals order confirmation ${orderId}`), text: customerText, html: customerHtml
    } : null,
    admin: order.adminEmailSentAt ? null : {
      from: config.from, to: config.adminTo, subject: cleanHeader(`New Nutikals order ${orderId}`), text: adminText, html: adminHtml,
      ...(validEmail(customer.email) ? { replyTo: cleanHeader(customer.email) } : {})
    }
  };
}

async function sendWithTransport(order, mailConfig, transport) {
  if (!transport || !mailConfig) throw new Error("Mailer is not configured.");
  const messages = makeOrderEmails(order, mailConfig);
  const results = { customerSent: false, adminSent: false, errors: [] };
  if (messages.customer) {
    try { await transport.sendMail(messages.customer); results.customerSent = true; }
    catch (error) { results.errors.push(error); }
  }
  if (messages.admin) {
    try { await transport.sendMail(messages.admin); results.adminSent = true; }
    catch (error) { results.errors.push(error); }
  }
  return results;
}

const configResult = readConfig();
if (configResult.warning) console.warn(configResult.warning);
const config = configResult.config;
const transporter = config ? createTransport(config) : null;

module.exports = {
  config,
  startupWarning: configResult.warning || "",
  transporter,
  sendOrderEmails: (order, transport = transporter) => sendWithTransport(order, config, transport),
  sendWithTransport,
  makeOrderEmails,
  createTransport,
  readConfig,
  configWarning,
  parseFrom,
  validEmail
};
