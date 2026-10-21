require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });

const mailer = require("../mailer");

async function main() {
  if (!mailer.config || !mailer.transporter) {
    console.error("SMTP test failed: mail configuration is incomplete or invalid.");
    process.exitCode = 1;
    return;
  }
  try {
    await mailer.transporter.verify();
    await mailer.transporter.sendMail({
      from: mailer.config.from,
      to: mailer.config.adminTo,
      subject: "Nutikals SMTP test",
      text: "SMTP is configured and the Nutikals application can send mail.",
      html: "<p>SMTP is configured and the Nutikals application can send mail.</p>"
    });
    console.log("SMTP verification passed and test message sent to MAIL_ADMIN_TO.");
  } catch (error) {
    console.error(`SMTP test failed: ${error.code || "SMTP_ERROR"}: ${String(error.message || "Unknown SMTP error").replace(/[\r\n]+/g, " ")}`);
    process.exitCode = 1;
  } finally {
    mailer.transporter.close();
  }
}

main();