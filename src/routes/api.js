const express = require("express");
const db = require("../db");
const { verifyBVN, verifyNIN } = require("../services/verification");
const { generateSubscriptionReference } = require("../services/reference");
const { notifySubscriber, notifyStaff, notifyEmail } = require("../services/notifications");
const { ngxApplyUrl } = require("../services/ngx");

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

// applyUrl is where the app should send the customer to apply (NGX's portal),
// or null when applications are handled by the in-app flow below.
router.get("/offers", (req, res) => {
  const applyUrl = ngxApplyUrl();
  const offers = db.listOffers({ statuses: ["OPEN", "DRAFT"] }).map((offer) => ({ ...offer, applyUrl }));
  res.json({ offers });
});

router.get("/offers/:offerId", (req, res) => {
  const offer = db.getOfferById(req.params.offerId);
  if (!offer) {
    return res.status(404).json({ error: "Offer not found" });
  }
  res.json({ offer: { ...offer, applyUrl: ngxApplyUrl() } });
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
    ngxRedirectedAt: sub.ngxRedirectedAt,
    // Lets History offer "continue on NGX" for an application still waiting there.
    applyUrl: sub.status === "SENT_TO_NGX" ? ngxApplyUrl() : null,
    bank: sub.status === "AWAITING_PAYMENT" ? bankDetails() : null,
  };
}

router.post("/offers/:offerId/subscribe", async (req, res) => {
  const offer = db.getOfferById(req.params.offerId);
  if (!offer || offer.status !== "OPEN") {
    return res.status(400).json({ error: "This offer is not currently open for subscription." });
  }

  // With NGX taking applications, this endpoint only records the investor's
  // details and hands back the NGX link - the share count and payment happen on
  // NGX. Older app builds still send a share count and expect bank details back
  // for a payment screen, so they get the NGX link in the error they already
  // display instead of a subscription they can't finish.
  const applyUrl = ngxApplyUrl();
  const sendsShares =
    req.body.numberOfShares !== undefined && req.body.numberOfShares !== null && req.body.numberOfShares !== "";
  if (applyUrl && sendsShares) {
    return res.status(400).json({
      error: `Applications for this offer are made on the NGX portal: ${applyUrl}`,
      applyUrl,
    });
  }

  const {
    bvn,
    email,
    phone,
    trinityAccountId,
    cscsAccountId,
    isForMinor,
    minorNin,
    numberOfShares,
    referralCode,
    consentAccepted,
  } = req.body;

  if (!consentAccepted) {
    return res.status(400).json({ error: "You must accept the offer documents to continue." });
  }

  const trimmedEmail = (email || "").trim();
  const trimmedPhone = (phone || "").trim();
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const bvnResult = await verifyBVN((bvn || "").trim());
  if (!bvnResult.verified) {
    return res.status(400).json({ error: bvnResult.message || "BVN verification failed." });
  }

  const subscriberFields = {
    bvn: (bvn || "").trim(),
    fullName: bvnResult.fullName,
    email: trimmedEmail,
    phone: trimmedPhone || null,
    trinityAccountId: (trinityAccountId || "").trim() || null,
    cscsAccountId: (cscsAccountId || "").trim() || null,
  };

  // Same one-application-per-offer guard as the web flow (see subscribe.js's
  // POST /account) - the app collects everything in one call, so this is the
  // earliest point identity is known here too.
  const duplicate = db.findOtherActiveSubscriptionForBvnAndOffer((bvn || "").trim(), offer.id);
  if (duplicate && applyUrl && duplicate.status === "SENT_TO_NGX") {
    // Already handed over to NGX (likely closed before paying): let them carry
    // on there instead of blocking them or leaving a second record.
    db.upsertSubscriberByBvn(subscriberFields);
    return res.json({ subscription: subscriptionToPublicJson(duplicate), applyUrl });
  }
  if (duplicate) {
    return res.status(400).json({
      error:
        `You already have an application for ${offer.name} (ref. ${duplicate.reference}, status: ` +
        `${duplicate.status.replace("_", " ").toLowerCase()}). Only one application per offer is allowed - ` +
        `please wait for that one to be processed.`,
    });
  }

  let minorId = null;
  if (isForMinor) {
    const ninResult = await verifyNIN((minorNin || "").trim());
    if (!ninResult.verified) {
      return res.status(400).json({ error: ninResult.message || "Minor NIN verification failed." });
    }
    minorId = db.createMinor({ nin: (minorNin || "").trim(), fullName: ninResult.fullName }).id;
  }

  if (applyUrl) {
    const subscriber = db.upsertSubscriberByBvn(subscriberFields);
    const subscription = db.createSubscription({
      offerId: offer.id,
      reference: generateSubscriptionReference(),
      referralCode: (referralCode || "").trim() || null,
    });
    const handedOverAt = new Date();
    const updated = db.updateSubscription(subscription.id, {
      subscriberId: subscriber.id,
      isForMinor: Boolean(isForMinor),
      minorId,
      status: "SENT_TO_NGX",
      consentAcceptedAt: handedOverAt,
      ngxRedirectedAt: handedOverAt,
    });
    return res.status(201).json({ subscription: subscriptionToPublicJson(updated), applyUrl });
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

  const subscriber = db.upsertSubscriberByBvn(subscriberFields);

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
      `Our team will verify the transfer and confirm shortly. Your application has been received - please do not ` +
      `submit another application for this offer; only one is allowed per investor.`,
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

// ---------------------------------------------------------------------
// Account closure/disable requests (mobile app Settings screen)
// ---------------------------------------------------------------------
// Identified by the EMSX trinityAccountId the app is already logged into -
// same trust model as GET /subscriptions above: no separate portal login.
// This never closes the account itself; it just records the request and
// alerts staff, who verify identity and follow up before anything changes.
router.use(["/account/close-request"], (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

router.post("/account/close-request", async (req, res) => {
  const trinityAccountId = (req.body.trinityAccountId || "").toString().trim();
  const email = (req.body.email || "").toString().trim();
  const reason = (req.body.reason || "").toString().trim().slice(0, 2000);
  if (!trinityAccountId) {
    return res.status(400).json({ error: "trinityAccountId is required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "A valid email is required" });
  }

  const request = db.createAccountClosureRequest({ trinityAccountId, email, reason });

  await notifyEmail({
    to: email,
    subject: "We've received your account request",
    message:
      "We've received your request to close or disable your Trinity Securities account. " +
      "Our team will contact you to verify your identity and confirm before anything changes. " +
      "If you didn't make this request, please contact support immediately.",
  });

  await notifyStaff({
    subject: `Account closure request - ${trinityAccountId}`,
    message:
      `A customer (Trinity account ${trinityAccountId}, ${email}) has requested to close or disable ` +
      `their account.${reason ? ` Reason given: ${reason}` : " No reason given."} ` +
      "Please verify their identity and follow up.",
  });

  res.status(201).json({ request });
});

module.exports = router;
