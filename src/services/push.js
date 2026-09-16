/**
 * Push notification service
 * -----------------------------------------------------------------------
 * Thin, pluggable layer around sending an advert as a device push, mirroring
 * verification.js's MOCK/LIVE split.
 *
 * PUSH_MODE=MOCK (default): logs what would have been sent and returns a
 * fake success, so adverts can be authored/sent end-to-end without a live
 * Firebase project. The in-app notification inbox (GET /api/adverts) always
 * shows sent adverts regardless of mode, so nothing is hidden in MOCK.
 *
 * PUSH_MODE=LIVE: sends through Firebase Cloud Messaging (Admin SDK). Needs
 * ONE of:
 *   - FCM_SERVICE_ACCOUNT_PATH: path to the service account JSON file
 *     (Firebase Console > Project Settings > Service Accounts > Generate
 *     new private key). Preferred - keep the file itself out of git (see
 *     .gitignore's secrets/) and chmod 600 it on the server like .env.
 *   - FCM_SERVICE_ACCOUNT_JSON: the same file's contents, inline as a
 *     single-line string, for environments where a file isn't convenient.
 * The mobile app also needs to be registered with the same Firebase project
 * and calling POST /api/device-tokens with each device's FCM token (see
 * api.js). Every caller still only ever talks to sendAdvertPush() below.
 * -----------------------------------------------------------------------
 */

const fs = require("fs");
const db = require("../db");

const MODE = process.env.PUSH_MODE || "MOCK";

let firebaseApp = null;
function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  const admin = require("firebase-admin");

  let credentialJson;
  if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
    credentialJson = fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_PATH, "utf8");
  } else if (process.env.FCM_SERVICE_ACCOUNT_JSON) {
    credentialJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  } else {
    throw new Error("Neither FCM_SERVICE_ACCOUNT_PATH nor FCM_SERVICE_ACCOUNT_JSON is set - cannot send LIVE push.");
  }
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credentialJson)) });
  return firebaseApp;
}

async function sendLive(advert, tokens) {
  const admin = require("firebase-admin");
  getFirebaseApp();
  if (!tokens.length) return { sent: 0, failed: 0 };

  const message = {
    notification: { title: advert.title, body: advert.message || "" },
    data: { advertId: advert.id, linkUrl: advert.linkUrl || "" },
  };

  // FCM's multicast send caps at 500 tokens per call.
  let sent = 0;
  let failed = 0;
  const staleTokens = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({ ...message, tokens: batch });
    sent += res.successCount;
    failed += res.failureCount;
    res.responses.forEach((r, idx) => {
      if (!r.success && r.error && r.error.code === "messaging/registration-token-not-registered") {
        staleTokens.push(batch[idx]);
      }
    });
  }
  staleTokens.forEach((t) => db.deleteDeviceToken(t));
  return { sent, failed };
}

/**
 * @param {object} advert - a row from db.getAdvertById()
 * @returns {Promise<{sent: number, failed: number, mode: string}>}
 */
async function sendAdvertPush(advert) {
  const tokens = db.listDeviceTokens().map((t) => t.token);

  if (MODE === "LIVE") {
    try {
      const result = await sendLive(advert, tokens);
      return { ...result, mode: "LIVE" };
    } catch (err) {
      console.error("Push send failed:", err.message);
      throw err;
    }
  }

  console.log(`[push MOCK] Would send "${advert.title}" to ${tokens.length} device(s).`);
  return { sent: tokens.length, failed: 0, mode: "MOCK" };
}

module.exports = { sendAdvertPush, MODE };
