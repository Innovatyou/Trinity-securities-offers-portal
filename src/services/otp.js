/**
 * OTP service (Security step / portal login)
 * -----------------------------------------------------------------------
 * Generates a real 6-digit code and holds it in the session; verification
 * always compares against that session value, in both modes - only how
 * the code reaches the subscriber changes.
 *
 * OTP_DELIVERY_MODE=MOCK (default): "sends" the code by handing it back
 * in the response (`devCode`) instead of dispatching it, so the flow can
 * be tested with no live credentials.
 *
 * OTP_DELIVERY_MODE=LIVE: emails or texts the code, depending on whether
 * `destination` looks like an email address or a phone number. Email goes
 * through whichever provider EMAIL_DELIVERY_PROVIDER selects (see
 * mailer.js); SMS always goes through Veltrix (Customer API `/api/v1`) -
 * set VELTRIX_BASE_URL, VELTRIX_API_KEY and VELTRIX_SMS_SENDER_ID.
 * -----------------------------------------------------------------------
 */

const veltrix = require("./veltrixClient");
const mailer = require("./mailer");

const MODE = process.env.OTP_DELIVERY_MODE || "MOCK";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function dispatchLive(destination, code) {
  const message = `Your Trinity Securities Offers Portal verification code is ${code}. It expires shortly - do not share it.`;

  if (EMAIL_RE.test(destination)) {
    const result = await mailer.sendEmail({
      to: destination,
      subject: "Your verification code",
      html: `<p>${message}</p>`,
    });
    if (!result.sent) {
      throw new Error(result.message || "Email dispatch failed.");
    }
    return;
  }

  const result = await veltrix.sendSms({ to: destination, message });
  if (!result.sent) {
    throw new Error(result.message || "SMS dispatch failed.");
  }
}

/**
 * @param {string} destination - email or phone number the OTP is sent to
 * @returns {Promise<{code: string, devCode?: string}>}
 */
async function sendOtp(destination) {
  const code = generateOtp();

  if (MODE === "LIVE") {
    await dispatchLive(destination, code);
    return { code };
  }

  // MOCK mode: hand the code back so it can be shown on-screen for testing.
  return { code, devCode: code };
}

function verifyOtp(submitted, expected) {
  return Boolean(submitted) && Boolean(expected) && submitted === expected;
}

module.exports = { sendOtp, verifyOtp };
