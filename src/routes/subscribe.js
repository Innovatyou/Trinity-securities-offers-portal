const express = require("express");
const db = require("../db");
const { loadSubscription } = require("../middleware/subscriptionFlow");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router({ mergeParams: true });

// Every response here carries session-scoped subscription state (BVN name,
// bank transfer reference, share amounts...), so it must never be cached by
// an intermediary proxy (this box's cPanel/nginx reverse-proxy cache in
// particular, which by default caches 200/301/302 responses for an hour
// with no notion of our session cookie - meaning a cached page here could
// get served to an entirely different subscriber). See admin.js for the
// same fix applied there first.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  next();
});

const STATUS_ORDER = [
  "STARTED",
  "ACCOUNT_VERIFIED",
  "AWAITING_PAYMENT",
  "PAYMENT_REPORTED",
  "CONFIRMED",
];

function bankDetails() {
  return {
    bankName: process.env.BANK_NAME || "Zenith Bank",
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || "1130098750",
    accountName:
      process.env.BANK_ACCOUNT_NAME || "TRINITY SECURITIES LIMITED - CLIENT ACCOUNT",
  };
}

// ---------- Step 1: Account (contact info + BVN + optional minor NIN) ----------

// The flow used to start with a separate OTP "Security" screen; removed as
// a friction/reliability point (SMS/email OTP delivery), but the flow's
// entry point and loadSubscription()'s failure redirects still point at
// this root path, so keep it as a thin redirect to the first real step.
router.get("/", loadSubscription(0, STATUS_ORDER), (req, res) => {
  res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
});

router.get("/account", loadSubscription(0, STATUS_ORDER), (req, res) => {
  const { subscription } = req;

  if (STATUS_ORDER.indexOf(subscription.status) >= STATUS_ORDER.indexOf("ACCOUNT_VERIFIED")) {
    return res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
  }

  res.render("subscribe/account", {
    title: "Account Verification",
    offer: subscription.offer,
    subscription,
    layout: "subscribe-layout",
    step: 1,
  });
});

router.post("/account", loadSubscription(0, STATUS_ORDER), (req, res) => {
  const { subscription } = req;
  const { subscriptionFor, bvn } = req.body;
  const isForMinor = subscriptionFor === "minor";

  const contactDestination = (req.body.contactDestination || "").trim();
  if (!contactDestination) {
    req.flash("error", "Enter your email or phone number.");
    return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
  }

  const verifiedBvn = req.session.verifiedBvn;
  if (!verifiedBvn || verifiedBvn.value !== (bvn || "").trim()) {
    req.flash("error", "Please verify your BVN before continuing.");
    return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
  }

  let minorId = null;
  if (isForMinor) {
    const nin = (req.body.nin || "").trim();
    const verifiedNin = req.session.verifiedNin;
    if (!verifiedNin || verifiedNin.value !== nin) {
      req.flash("error", "Please verify the minor's NIN before continuing.");
      return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
    }

    const minor = db.createMinor({ nin, fullName: verifiedNin.fullName });
    minorId = minor.id;
  }

  const contactEmail = EMAIL_RE.test(contactDestination) ? contactDestination : null;
  const contactPhone = EMAIL_RE.test(contactDestination) ? null : contactDestination;

  const subscriber = db.upsertSubscriberByBvn({
    bvn: verifiedBvn.value,
    fullName: verifiedBvn.fullName,
    email: contactEmail,
    phone: contactPhone,
  });

  db.updateSubscription(subscription.id, {
    subscriberId: subscriber.id,
    isForMinor,
    minorId,
    status: "ACCOUNT_VERIFIED",
  });

  req.session.verifiedBvn = null;
  req.session.verifiedNin = null;

  res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
});

// ---------- Step 2: Participation (shares + payment) ----------

router.get(
  "/participation",
  loadSubscription(STATUS_ORDER.indexOf("ACCOUNT_VERIFIED"), STATUS_ORDER),
  (req, res) => {
    const { subscription } = req;

    if (STATUS_ORDER.indexOf(subscription.status) >= STATUS_ORDER.indexOf("PAYMENT_REPORTED")) {
      return res.redirect(`/offers/${req.params.offerId}/subscribe/success`);
    }

    res.render("subscribe/participation", {
      title: "Participation",
      offer: subscription.offer,
      subscription,
      subscriber: subscription.subscriber,
      bank: bankDetails(),
      layout: "subscribe-layout",
      step: 2,
    });
  }
);

router.post(
  "/participation",
  loadSubscription(STATUS_ORDER.indexOf("ACCOUNT_VERIFIED"), STATUS_ORDER),
  (req, res) => {
    const { subscription } = req;
    const offer = subscription.offer;
    const shares = parseInt(req.body.numberOfShares, 10);
    const consentAccepted = req.body.consent === "on";

    if (!consentAccepted) {
      req.flash("error", "Please confirm you have read and accept the offer documents.");
      return res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
    }

    if (
      !Number.isInteger(shares) ||
      shares < offer.minimumShares ||
      shares % offer.multipleOf !== 0 ||
      (offer.maximumShares && shares > offer.maximumShares)
    ) {
      req.flash(
        "error",
        `Enter a valid number of shares (minimum ${offer.minimumShares}, in multiples of ${offer.multipleOf}).`
      );
      return res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
    }

    const amount = shares * offer.pricePerShare;

    db.updateSubscription(subscription.id, {
      numberOfShares: shares,
      amount,
      paymentMethod: "BANK_TRANSFER",
      status: "AWAITING_PAYMENT",
      consentAcceptedAt: new Date(),
    });

    res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
  }
);

router.post(
  "/participation/report-payment",
  loadSubscription(STATUS_ORDER.indexOf("AWAITING_PAYMENT"), STATUS_ORDER),
  (req, res) => {
    db.updateSubscription(req.subscription.id, {
      status: "PAYMENT_REPORTED",
      transferReportedAt: new Date(),
    });
    res.redirect(`/offers/${req.params.offerId}/subscribe/success`);
  }
);

// ---------- Success ----------

router.get(
  "/success",
  loadSubscription(STATUS_ORDER.indexOf("PAYMENT_REPORTED"), STATUS_ORDER),
  (req, res) => {
    res.render("subscribe/success", {
      title: "Subscription Received",
      offer: req.subscription.offer,
      subscription: req.subscription,
      layout: "subscribe-layout",
      step: 2,
    });
  }
);

module.exports = router;
