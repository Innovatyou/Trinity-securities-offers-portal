/**
 * Email transport switch
 * -----------------------------------------------------------------------
 * admin.js calls sendEmail() here once its own MOCK/LIVE flag
 * has already decided to actually deliver - this only decides HOW.
 * SMS has no SMTP equivalent, so it always goes through veltrixClient.
 *
 * EMAIL_DELIVERY_PROVIDER=VELTRIX (default): routes through Veltrix's
 * Customer API, wallet-billed the same as SMS - see veltrixClient.js.
 *
 * EMAIL_DELIVERY_PROVIDER=SMTP: sends directly through a mailbox you
 * control (e.g. one created in cPanel for this domain), bypassing
 * Veltrix's wallet for email entirely. Set SMTP_HOST, SMTP_PORT,
 * SMTP_SECURE, SMTP_USER, SMTP_PASS - the "from" identity still comes
 * from VELTRIX_EMAIL_FROM / VELTRIX_EMAIL_FROM_NAME regardless of which
 * provider is active.
 * -----------------------------------------------------------------------
 */

const veltrix = require("./veltrixClient");

function provider() {
  return (process.env.EMAIL_DELIVERY_PROVIDER || "VELTRIX").toUpperCase();
}

let transport = null;
function getSmtpTransport() {
  if (transport) return transport;
  const nodemailer = require("nodemailer");
  const host = process.env.SMTP_HOST || "";
  if (!host) {
    throw new Error("SMTP_HOST is not set.");
  }
  transport = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  return transport;
}

async function sendViaSmtp({ to, toName = "", subject, html, attachments, cc }) {
  const fromAddress = process.env.VELTRIX_EMAIL_FROM || process.env.SMTP_USER || "";
  if (!fromAddress) {
    throw new Error("VELTRIX_EMAIL_FROM (or SMTP_USER) is not set - needed as the SMTP \"from\" address.");
  }
  const fromName = process.env.VELTRIX_EMAIL_FROM_NAME || "Trinity Securities Limited";

  try {
    await getSmtpTransport().sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: toName ? `"${toName}" <${to}>` : to,
      cc: cc && cc.length ? cc : undefined,
      replyTo: process.env.VELTRIX_EMAIL_REPLY_TO || undefined,
      subject,
      html,
      attachments,
    });
    return { sent: true };
  } catch (err) {
    console.error("[SMTP] Email send failed:", err.message);
    return { sent: false, message: err.message };
  }
}

/**
 * @param {{to: string, toName?: string, subject: string, html: string, attachments?: {filename: string, content: Buffer}[], cc?: string[]}} params
 *   `attachments` is only honored by the SMTP provider - Veltrix's transactional-emails API has no
 *   attachment field, so it's silently dropped there (the HTML body still carries the same content).
 *   `cc` is sent as a real CC header on SMTP; Veltrix has no multi-recipient field, so each CC
 *   address instead gets its own copy of the same email as a separate send.
 * @returns {Promise<{sent: boolean, message?: string}>}
 */
async function sendEmail(params) {
  if (provider() === "SMTP") {
    return sendViaSmtp(params);
  }

  if (params.attachments && params.attachments.length) {
    console.warn("[mailer] EMAIL_DELIVERY_PROVIDER=VELTRIX cannot send attachments - sending body only.");
  }
  const { attachments, cc, ...veltrixParams } = params;
  const result = await veltrix.sendEmail(veltrixParams);

  if (cc && cc.length) {
    await Promise.all(cc.map((addr) => veltrix.sendEmail({ ...veltrixParams, to: addr, toName: "" })));
  }

  return result;
}

module.exports = { sendEmail };
