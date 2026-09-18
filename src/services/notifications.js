/**
 * Subscriber + staff notifications
 * -----------------------------------------------------------------------
 * Shared between subscribe.js (public flow - awaiting payment, payment
 * reported) and admin.js (confirm/reject).
 *
 * NOTIFICATIONS_MODE=MOCK (default) only logs, so nothing is sent until
 * NOTIFICATIONS_MODE=LIVE is set. Best-effort: a failed notification never
 * blocks the action that triggered it.
 * -----------------------------------------------------------------------
 */

const veltrix = require("./veltrixClient");
const mailer = require("./mailer");

function mode() {
  return process.env.NOTIFICATIONS_MODE || "MOCK";
}

/**
 * @param {object} subscription - a subscription from db.js, with subscriber attached
 * @param {{subject: string, message: string}} params
 */
async function notifySubscriber(subscription, { subject, message }) {
  const subscriber = subscription && subscription.subscriber;
  if (!subscriber) return;

  if (mode() !== "LIVE") {
    console.log(`[notify:MOCK] ${subscriber.email || subscriber.phone}: ${subject}`);
    return;
  }

  try {
    if (subscriber.email) {
      await mailer.sendEmail({ to: subscriber.email, toName: subscriber.fullName, subject, html: `<p>${message}</p>` });
    }
    if (subscriber.phone) {
      await veltrix.sendSms({ to: subscriber.phone, message });
    }
  } catch (err) {
    console.error("Subscriber notification failed:", err.message);
  }
}

/**
 * Emails an arbitrary address directly - for flows (like account closure
 * requests) that don't have a db.js subscriber row to hang the address off
 * of. Same MOCK-mode gating and best-effort behaviour as notifySubscriber.
 * @param {{to: string, toName?: string, subject: string, message: string}} params
 */
async function notifyEmail({ to, toName, subject, message }) {
  if (!to) return;

  if (mode() !== "LIVE") {
    console.log(`[notify:MOCK] ${to}: ${subject}`);
    return;
  }

  try {
    await mailer.sendEmail({ to, toName, subject, html: `<p>${message}</p>` });
  } catch (err) {
    console.error("Email notification failed:", err.message);
  }
}

/**
 * Emails Trinity's internal staff list (STAFF_NOTIFY_TO / STAFF_NOTIFY_CC
 * in .env) - e.g. when a payment is reported and needs reconciling.
 * No-op if STAFF_NOTIFY_TO isn't set.
 */
async function notifyStaff({ subject, message }) {
  const to = (process.env.STAFF_NOTIFY_TO || "").trim();
  if (!to) return;
  const cc = (process.env.STAFF_NOTIFY_CC || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (mode() !== "LIVE") {
    console.log(`[notify:MOCK] staff <${to}>${cc.length ? ` cc:${cc.join(",")}` : ""}: ${subject}`);
    return;
  }

  try {
    await mailer.sendEmail({ to, cc, subject, html: `<p>${message}</p>` });
  } catch (err) {
    console.error("Staff notification failed:", err.message);
  }
}

module.exports = { notifySubscriber, notifyStaff, notifyEmail };
