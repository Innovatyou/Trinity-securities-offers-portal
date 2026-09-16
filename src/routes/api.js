const express = require("express");
const db = require("../db");
const { verifyBVN, verifyNIN } = require("../services/verification");

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

// Small JSON endpoints the Account step calls via fetch() to verify BVN / minor NIN
// inline, the same way the reference screenshots show an inline "Verify" button.
// Results are cached on the session and re-checked when the step is actually
// submitted, so nothing is trusted purely on the client side.

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
