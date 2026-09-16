const express = require("express");
const db = require("../db");
const { verifyBVN, verifyNIN } = require("../services/verification");
const { generateSubscriptionReference } = require("../services/reference");
const { notifySubscriber, notifyStaff } = require("../services/notifications");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// Public read-only offers feed for the mobile app. No session/auth - same data
// the web home page shows - so a permissive CORS + no-cache policy is fine here.
// Kept separate from /verify-bvn and /verify-nin below, which stay same-origin.
router.use(["/offers", "/offers/:offerId"], (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

router.get("/offers", (req, res) => {
  const offers = db.listOffers({ statuses: ["OPEN", "DRAFT"] });
  res.json({ offers });
});

router.get("/offers/:offerId", (req, res) => {
  const offer = db.getOfferById(req.params.offerId);
  if (!offer) {
    return res.status(404).json({ error: "Offer not found" });
  }
  res.json({ offer });
});

// Public read-only News/Analysis, Recommendations, and Adverts feeds for the
// mobile app - same shape as /offers above: no auth, permissive CORS, no-cache.
router.use(
  ["/news", "/news/:id", "/recommendations", "/adverts/banners", "/adverts/notifications"],
  (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    next();
  }
);

router.get("/news", (req, res) => {
  res.json({ articles: db.listNews({ statuses: ["PUBLISHED"] }) });
});

router.get("/news/:id", (req, res) => {
  const article = db.getNewsById(req.params.id);
  if (!article || article.status !== "PUBLISHED") {
    return res.status(404).json({ error: "Article not found" });
  }
  res.json({ article });
});

router.get("/recommendations", (req, res) => {
  res.json({ recommendations: db.listRecommendations({ statuses: ["PUBLISHED"] }) });
});

// Active banner adverts for the app's Home carousel.
router.get("/adverts/banners", (req, res) => {
  res.json({ adverts: db.listAdverts({ statuses: ["ACTIVE"], placements: ["BANNER", "BOTH"] }) });
});

// Sent notification-style adverts, for the app's in-app notification inbox.
// Only ones actually sent (sentAt set) - a DRAFT/unsent advert stays invisible
// here even if PUSH_MODE is MOCK, so the inbox always matches what admins hit
// "Send now" on, not what merely exists.
router.get("/adverts/notifications", (req, res) => {
  const adverts = db
    .listAdverts({ statuses: ["ACTIVE", "EXPIRED"], placements: ["NOTIFICATION", "BOTH"] })
    .filter((a) => a.sentAt);
  res.json({ adverts });
});

// Mobile app calls this once it has an FCM token (on launch, and again
// whenever Firebase rotates the token) so push.js has somewhere to send to.
// CORS'd + unauthenticated like the feeds above: registering a token isn't
// sensitive, and the app has no login step of its own to gate it behind.
router.use(["/device-tokens"], (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  next();
});

router.post("/device-tokens", (req, res) => {
  const { token, platform } = req.body;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "token is required" });
  }
  db.upsertDeviceToken({ token, platform: (platform || "unknown").toString() });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Mobile in-app subscription flow
// ---------------------------------------------------------------------
// The web flow (subscribe.js) spreads Account -> Participation across
// session-backed page loads. The app collects both steps' fields in its own
// screens before submitting, so this collapses that into one call: verifies
// BVN/NIN itself (never trusts a client-side "already verified" flag),
// creates the subscriber + subscription, and leaves it AWAITING_PAYMENT with
// a bank reference - same manual-transfer-then-admin-reconciles ending as
// the web flow, just without the page-to-page hand-off.
router.use(
  ["/offers/:offerId/subscribe", "/subscriptions", "/subscriptions/:id/report-payment"],
  (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    next();
  }
);

function bankDetails() {
  return {
    bankName: process.env.BANK_NAME || "Zenith Bank",
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || "1130098750",
    accountName: process.env.BANK_ACCOUNT_NAME || "TRINITY SECURITIES LIMITED - CLIENT ACCOUNT",
  };
}

// Trims the internal subscription shape down to what the app needs, and
// never echoes BVN/NIN back over the wire - the app already knows its own
// input, no reason to widen exposure on every history fetch.
function subscriptionToPublicJson(sub) {
  return {
    id: sub.id,
    reference: sub.reference,
    status: sub.status,
    offerId: sub.offerId,
    offerName: sub.offer ? sub.offer.name : null,
    offerIssuer: sub.offer ? sub.offer.issuer : null,
    currency: sub.offer ? sub.offer.currency : "NGN",
    numberOfShares: sub.numberOfShares,
    amount: sub.amount,
    isForMinor: sub.isForMinor,
    createdAt: sub.createdAt,
    consentAcceptedAt: sub.consentAcceptedAt,
    transferReportedAt: sub.transferReportedAt,
    confirmedAt: sub.confirmedAt,
    allottedShares: sub.allottedShares ?? null,
    allottedAt: sub.allottedAt,
    bank: sub.status === "AWAITING_PAYMENT" ? bankDetails() : null,
  };
}

router.post("/offers/:offerId/subscribe", async (req, res) => {
  const offer = db.getOfferById(req.params.offerId);
  if (!offer || offer.status !== "OPEN") {
    return res.status(400).json({ error: "This offer is not currently open for subscription." });
  }

  const {
    bvn,
    contactDestination,
    trinityAccountId,
    isForMinor,
    minorNin,
    numberOfShares,
    referralCode,
    consentAccepted,
  } = req.body;

  if (!consentAccepted) {
    return res.status(400).json({ error: "You must accept the offer documents to continue." });
  }

  const contact = (contactDestination || "").trim();
  if (!contact) {
    return res.status(400).json({ error: "Enter your email or phone number." });
  }

  const bvnResult = await verifyBVN((bvn || "").trim());
  if (!bvnResult.verified) {
    return res.status(400).json({ error: bvnResult.message || "BVN verification failed." });
  }

  let minorId = null;
  if (isForMinor) {
    const ninResult = await verifyNIN((minorNin || "").trim());
    if (!ninResult.verified) {
      return res.status(400).json({ error: ninResult.message || "Minor NIN verification failed." });
    }
    minorId = db.createMinor({ nin: (minorNin || "").trim(), fullName: ninResult.fullName }).id;
  }

  const shares = parseInt(numberOfShares, 10);
  if (
    !Number.isInteger(shares) ||
    shares < offer.minimumShares ||
    shares % offer.multipleOf !== 0 ||
    (offer.maximumShares && shares > offer.maximumShares)
  ) {
    return res.status(400).json({
      error: `Enter a valid number of shares (minimum ${offer.minimumShares}, in multiples of ${offer.multipleOf}).`,
    });
  }

  const subscriber = db.upsertSubscriberByBvn({
    bvn: (bvn || "").trim(),
    fullName: bvnResult.fullName,
    email: EMAIL_RE.test(contact) ? contact : null,
    phone: EMAIL_RE.test(contact) ? null : contact,
    trinityAccountId: (trinityAccountId || "").trim() || null,
  });

  const subscription = db.createSubscription({
    offerId: offer.id,
    reference: generateSubscriptionReference(),
    referralCode: (referralCode || "").trim() || null,
  });

  const amount = shares * offer.pricePerShare;
  const updated = db.updateSubscription(subscription.id, {
    subscriberId: subscriber.id,
    isForMinor: Boolean(isForMinor),
    minorId,
    numberOfShares: shares,
    amount,
    paymentMethod: "BANK_TRANSFER",
    status: "AWAITING_PAYMENT",
    consentAcceptedAt: new Date(),
  });

  const bank = bankDetails();
  await notifySubscriber(updated, {
    subject: "Complete your Trinity Securities subscription - payment details",
    message:
      `Your subscription (ref. ${updated.reference}) for ${shares.toLocaleString()} shares in ${offer.name} ` +
      `is ready for payment. Amount: ${offer.currency}${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}. ` +
      `Transfer to ${bank.bankName}, account ${bank.accountNumber} (${bank.accountName}), and use ${updated.reference} ` +
      `as your transfer narration.`,
  });

  res.status(201).json({ subscription: subscriptionToPublicJson(updated) });
});

router.post("/subscriptions/:id/report-payment", async (req, res) => {
  const subscription = db.getSubscriptionById(req.params.id);
  if (!subscription || subscription.status !== "AWAITING_PAYMENT") {
    return res.status(400).json({ error: "This subscription is not awaiting payment." });
  }

  const updated = db.updateSubscription(subscription.id, {
    status: "PAYMENT_REPORTED",
    transferReportedAt: new Date(),
  });

  await notifySubscriber(updated, {
    subject: "We've received your payment report",
    message:
      `We've received your payment report for subscription (ref. ${updated.reference}) in ${subscription.offer.name}. ` +
      `Our team will verify the transfer and confirm shortly.`,
  });

  const adminUrl = `${req.protocol}://${req.get("host")}/admin/subscriptions`;
  await notifyStaff({
    subject: `Payment reported - ${updated.reference}`,
    message:
      `${updated.subscriber ? updated.subscriber.fullName : "An investor"} reported payment for subscription ` +
      `${updated.reference} - ${updated.numberOfShares.toLocaleString()} shares (${subscription.offer.currency}` +
      `${updated.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}) in ${subscription.offer.name}. ` +
      `Please verify the transfer and confirm in the admin dashboard: ${adminUrl}`,
  });

  res.json({ subscription: subscriptionToPublicJson(updated) });
});

// History screen: "my subscriptions" identified by the EMSX trinityAccountId
// the app is already logged into - no separate app login needed. Anyone who
// knows a real trinityAccountId could look up that account's history (same
// trust level as the rest of this public API), which is an accepted
// trade-off for not building a second auth system on top of EMSX's own.
router.get("/subscriptions", (req, res) => {
  const trinityAccountId = (req.query.trinityAccountId || "").trim();
  if (!trinityAccountId) {
    return res.status(400).json({ error: "trinityAccountId is required" });
  }
  const subscriptions = db.listSubscriptionsByTrinityAccountId(trinityAccountId);
  res.json({ subscriptions: subscriptions.map(subscriptionToPublicJson) });
});

// Small JSON endpoints the Account step calls via fetch() to verify BVN / minor NIN
// inline, the same way the reference screenshots show an inline "Verify" button.
// Also used directly by the mobile app's own Account step for the same inline
// feedback - the /offers/:offerId/subscribe endpoint above always re-verifies
// server-side regardless, so nothing is ever trusted purely off this call.
router.use(["/verify-bvn", "/verify-nin"], (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  next();
});

router.post("/verify-bvn", async (req, res) => {
  const { bvn } = req.body;
  const result = await verifyBVN((bvn || "").trim());

  if (result.verified) {
    req.session.verifiedBvn = { value: bvn.trim(), fullName: result.fullName };
  } else {
    req.session.verifiedBvn = null;
  }

  res.json(result);
});

router.post("/verify-nin", async (req, res) => {
  const { nin } = req.body;
  const result = await verifyNIN((nin || "").trim());

  if (result.verified) {
    req.session.verifiedNin = { value: nin.trim(), fullName: result.fullName };
  } else {
    req.session.verifiedNin = null;
  }

  res.json(result);
});

module.exports = router;
