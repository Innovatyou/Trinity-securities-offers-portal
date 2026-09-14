const express = require("express");
const db = require("../db");
const { sendOtp, verifyOtp, EMAIL_RE } = require("../services/otp");
const { loadSubscription } = require("../middleware/subscriptionFlow");

const router = express.Router({ mergeParams: true });

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

// ---------- Step 1: Security ----------

router.get("/", loadSubscription(0, STATUS_ORDER), (req, res) => {
  const { subscription } = req;

  if (req.session.securityVerifiedFor === subscription.id) {
    return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
  }

  res.render("subscribe/security", {
    title: "Security Verification",
    offer: subscription.offer,
    subscription,
    layout: "subscribe-layout",
    step: 1,
  });
});

router.post("/send-otp", loadSubscription(0, STATUS_ORDER), async (req, res) => {
  const destination = (req.body.destination || "").trim();
  if (!destination) {
    return res.json({ ok: false, message: "Enter your registered email or phone number." });
  }

  try {
    const { code, devCode } = await sendOtp(destination);
    req.session.otp = { code, destination, subscriptionId: req.subscription.id };

    // devCode is only present in OTP_DELIVERY_MODE=MOCK; in LIVE mode the code
    // was already emailed/texted and never touches this response.
    res.json({ ok: true, destination, devCode });
  } catch (err) {
    console.error("OTP dispatch failed:", err.message);
    res.json({ ok: false, message: "Could not send the verification code. Please try again." });
  }
});

router.post("/verify-otp", loadSubscription(0, STATUS_ORDER), (req, res) => {
  const { code } = req.body;
  const stored = req.session.otp;

  const valid =
    stored &&
    stored.subscriptionId === req.subscription.id &&
    verifyOtp(code, stored.code);

  if (!valid) {
    return res.json({ ok: false, message: "That code is incorrect or has expired." });
  }

  req.session.securityVerifiedFor = req.subscription.id;
  res.json({ ok: true, redirectTo: `/offers/${req.params.offerId}/subscribe/account` });
});

// ---------- Step 2: Account (BVN + optional minor NIN) ----------

router.get("/account", loadSubscription(0, STATUS_ORDER), (req, res) => {
  const { subscription } = req;

  if (req.session.securityVerifiedFor !== subscription.id) {
    req.flash("error", "Please complete security verification first.");
    return res.redirect(`/offers/${req.params.offerId}/subscribe`);
  }

  if (STATUS_ORDER.indexOf(subscription.status) >= STATUS_ORDER.indexOf("ACCOUNT_VERIFIED")) {
    return res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
  }

  res.render("subscribe/account", {
    title: "Account Verification",
    offer: subscription.offer,
    subscription,
    layout: "subscribe-layout",
    step: 2,
  });
});

router.post("/account", loadSubscription(0, STATUS_ORDER), (req, res) => {
  const { subscription } = req;
  const { subscriptionFor, bvn } = req.body;
  const isForMinor = subscriptionFor === "minor";

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

  // Whichever channel they verified with at the Security step (session.otp
  // is only cleared on a fresh send-otp, so it's still there at this point).
  const otpSession = req.session.otp;
  const verifiedDestination =
    otpSession && otpSession.subscriptionId === subscription.id ? otpSession.destination : null;
  const contactEmail = verifiedDestination && EMAIL_RE.test(verifiedDestination) ? verifiedDestination : null;
  const contactPhone = verifiedDestination && !EMAIL_RE.test(verifiedDestination) ? verifiedDestination : null;

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

// ---------- Step 3: Participation (shares + payment) ----------

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
      step: 3,
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
      step: 3,
    });
  }
);

module.exports = router;
