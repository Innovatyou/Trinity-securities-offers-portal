/**
 * Veltrix API client
 * -----------------------------------------------------------------------
 * Thin wrapper around the two Veltrix (parent platform) surfaces this app
 * uses. Both are documented from inside Veltrix itself:
 *
 *  - Verify Partner API (`/api/verify/v1`) - BVN/NIN identity lookups.
 *    Auth: `Authorization: Bearer <credential>`, where <credential> is the
 *    single `key_id.secret` string Veltrix shows ONCE, in one copy box, right
 *    after you click "Create credential" at Veltrix > Customer > Verify >
 *    API Access (scope: kyc). There is no separate "Key ID" field to hunt
 *    for afterwards - copy that one string whole into VELTRIX_VERIFY_CREDENTIAL.
 *    Docs at Veltrix > Customer > Verify > API Access > Docs.
 *
 *  - Customer API (`/api/v1`) - transactional email + SMS.
 *    Auth: `X-MW-PUBLIC-KEY: <api_key>`, a key issued at
 *    Veltrix > Customer > API Keys.
 *
 * These are two separate credentials on purpose (Veltrix scopes and rate
 * limits them independently) - do not swap one for the other.
 *
 * Node 18+ ships a global fetch(), so this adds no HTTP dependency.
 * -----------------------------------------------------------------------
 */

function baseUrl() {
  const url = (process.env.VELTRIX_BASE_URL || "").replace(/\/+$/, "");
  if (!url) {
    throw new Error("VELTRIX_BASE_URL is not set.");
  }
  return url;
}

async function postJson(path, body, headers) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function partnerHeaders() {
  const credential = process.env.VELTRIX_VERIFY_CREDENTIAL || "";
  if (!credential) {
    throw new Error("VELTRIX_VERIFY_CREDENTIAL is not set.");
  }
  return { Authorization: `Bearer ${credential}` };
}

function customerApiHeaders() {
  const apiKey = process.env.VELTRIX_API_KEY || "";
  if (!apiKey) {
    throw new Error("VELTRIX_API_KEY is not set.");
  }
  return { "X-MW-PUBLIC-KEY": apiKey };
}

// Every BVN/NIN check and every SMS send is wallet-billed against whichever
// Veltrix customer account issued the credentials above - there is no
// separate "platform" wallet. When that account's Verify wallet, campaign
// wallet or subscription runs out, Veltrix answers with HTTP 402 and a
// human-readable reason ("Insufficient wallet balance...", "No active
// Veltrix Verify subscription..."). That text is written for Trinity's own
// ops team, not for the public investor filling in the form, so it is
// logged loudly here and never passed through to a caller-facing message.
const BILLING_ISSUE_RE = /wallet|subscription|billing/i;

function reportIfBillingIssue(status, context, rawMessage) {
  if (status === 402 || BILLING_ISSUE_RE.test(rawMessage || "")) {
    console.error(`[VELTRIX WALLET] ${context}: ${rawMessage} - fund the wallet / check the Verify subscription at Veltrix.`);
    return true;
  }
  return false;
}

/**
 * Runs a BVN or NIN identity lookup through Veltrix Verify.
 *
 * @param {"bvn"|"nin"} type
 * @param {string} identifier - the 11-digit BVN/NIN
 * @param {string} [expectedName] - optional name to cross-check against the registry record
 * @returns {Promise<{verified: boolean, fullName?: string, message?: string}>}
 */
async function verifyIdentity(type, identifier, expectedName = "") {
  const { status, json } = await postJson(
    "/api/verify/v1/kyc/identity",
    { type, identifier, name: expectedName },
    partnerHeaders()
  );

  if (json.status !== "success") {
    const raw = json.error || "Verification failed.";
    if (reportIfBillingIssue(status, `${type.toUpperCase()} check`, raw)) {
      return { verified: false, message: "Verification is temporarily unavailable. Please try again shortly or contact support." };
    }
    return { verified: false, message: raw };
  }

  const check = (json.data && json.data.check) || {};
  return {
    // check.status is "success" (record found), "not_found" or "error" - not to be
    // confused with the HTTP envelope's own top-level "status".
    verified: check.status === "success",
    fullName: check.name || undefined,
    message: (json.data && json.data.message) || undefined,
  };
}

/**
 * Sends a transactional email through Veltrix.
 *
 * @param {{to: string, toName?: string, subject: string, html: string}} params
 * @returns {Promise<{sent: boolean, message?: string}>}
 */
async function sendEmail({ to, toName = "", subject, html }) {
  const { status, json } = await postJson(
    "/api/v1/transactional-emails",
    {
      to_email: to,
      to_name: toName,
      subject,
      body: html,
      from_email: process.env.VELTRIX_EMAIL_FROM || undefined,
      from_name: process.env.VELTRIX_EMAIL_FROM_NAME || "Trinity Securities Limited",
      reply_to_email: process.env.VELTRIX_EMAIL_REPLY_TO || undefined,
    },
    customerApiHeaders()
  );

  if (json.status !== "success") {
    reportIfBillingIssue(status, "Email send", json.error);
    return { sent: false, message: json.error };
  }
  return { sent: true };
}

/**
 * Sends a one-off SMS through Veltrix's wallet-billed Quick Send.
 * `sender` must be an approved sender ID on the Veltrix account
 * (Veltrix > Customer > SMS > Sender IDs) - falls back to VELTRIX_SMS_SENDER_ID.
 *
 * @param {{to: string, message: string, sender?: string}} params
 * @returns {Promise<{sent: boolean, message?: string}>}
 */
async function sendSms({ to, message, sender }) {
  const { status, json } = await postJson(
    "/api/v1/sms-tools/quick-send",
    {
      sender: sender || process.env.VELTRIX_SMS_SENDER_ID || "",
      message,
      recipients: to,
    },
    customerApiHeaders()
  );

  if (json.status !== "success") {
    reportIfBillingIssue(status, "SMS send", json.error);
    return { sent: false, message: json.error };
  }
  const sentCount = (json.data && json.data.sent) || 0;
  if (sentCount === 0) {
    return { sent: false, message: "Gateway rejected the message." };
  }
  return { sent: true };
}

module.exports = { verifyIdentity, sendEmail, sendSms };
