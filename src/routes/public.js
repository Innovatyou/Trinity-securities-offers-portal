const express = require("express");
const db = require("../db");
const { generateSubscriptionReference } = require("../services/reference");

const router = express.Router();

// Offer status/content changes whenever staff edit an offer, and this box's
// cPanel/nginx reverse-proxy cache by default caches 200/301/302 responses
// for an hour - so without this, a closed/updated offer could keep showing
// its old state to the public for up to an hour after the change. See
// admin.js/subscribe.js for the same fix applied there first.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  next();
});

// Home: list currently open (and upcoming) offers
router.get("/", (req, res) => {
  const offers = db.listOffers({ statuses: ["OPEN", "DRAFT"] });
  res.render("home", { title: "Public Offers", offers });
});

// Offer detail page - mirrors the first screenshot (price, min/multiple, referral code, Start Subscription)
router.get("/offers/:offerId", (req, res) => {
  const offer = db.getOfferById(req.params.offerId);
  if (!offer) {
    req.flash("error", "That offer could not be found.");
    return res.redirect("/");
  }
  res.render("offer", { title: offer.name, offer });
});

// Start a new subscription for an offer, then send the subscriber into the 3-step flow
router.post("/offers/:offerId/start", (req, res) => {
  const offer = db.getOfferById(req.params.offerId);
  if (!offer || offer.status !== "OPEN") {
    req.flash("error", "This offer is not currently open for subscription.");
    return res.redirect("/");
  }

  const subscription = db.createSubscription({
    offerId: offer.id,
    reference: generateSubscriptionReference(),
    referralCode: (req.body.referralCode || "").trim() || null,
  });

  req.session.subscriptionId = subscription.id;
  req.session.securityVerifiedFor = null;

  res.redirect(`/offers/${offer.id}/subscribe`);
});

module.exports = router;
