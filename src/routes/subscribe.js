const express = require("express");
const db = require("../db");
const { loadSubscription } = require("../middleware/subscriptionFlow");
const { notifySubscriber, notifyStaff } = require("../services/notifications");
const { ngxApplyUrl } = require("../services/ngx");

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

// With NGX_APPLY_URL set, the details form below ends by handing the investor
// over to NGX and marking the subscription SENT_TO_NGX. There is nothing left
// to do here after that, so any step of this flow (a back button, a resubmitted
// form) just shows the hand-off page again with a way back to NGX - rather than
// falling through to loadSubscription(), which doesn't know that status.
router.use((req, res, next) => {
  const subscriptionId = req.session.subscriptionId;
  if (!subscriptionId) return next();

  const subscription = db.getSubscriptionById(subscriptionId);
  if (!subscription || subscription.offerId !== req.params.offerId || subscription.status !== "SENT_TO_NGX") {
    return next();
  }

  const applyUrl = ngxApplyUrl();
  if (!applyUrl) {
    req.flash(
      "error",
      `Your application (ref. ${subscription.reference}) was sent to NGX. Please contact Trinity Securities ` +
        `Limited if you need help with it.`
    );
    return res.redirect(`/offers/${req.params.offerId}`);
  }

  res.render("subscribe/ngx-handoff", {
    title: "Continue on NGX",
    offer: subscription.offer,
    subscription,
    applyUrl,
    layout: "subscribe-layout",
    step: 2,
  });
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
  const applyUrl = ngxApplyUrl();

  const email = (req.body.email || "").trim();
  const phone = (req.body.phone || "").trim();
  if (!email || !EMAIL_RE.test(email)) {
    req.flash("error", "Enter a valid email address.");
    return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
  }

  // NGX takes the application from here, so the consent that used to be given
  // on the Participation step is given on this form, before "Invest Now".
  if (applyUrl && req.body.consent !== "on") {
    req.flash("error", "Please confirm you have read and accept the offer documents.");
    return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
  }

  const verifiedBvn = req.session.verifiedBvn;
  if (!verifiedBvn || verifiedBvn.value !== (bvn || "").trim()) {
    req.flash("error", "Please verify your BVN before continuing.");
    return res.redirect(`/offers/${req.params.offerId}/subscribe/account`);
  }

  const subscriberFields = {
    bvn: verifiedBvn.value,
    fullName: verifiedBvn.fullName,
    email,
    phone: phone || null,
    trinityAccountId: (req.body.trinityAccountId || "").trim() || null,
    cscsAccountId: (req.body.cscsAccountId || "").trim() || null,
  };

  // One application per offer per investor - a rejected one doesn't count,
  // everything else (in progress, awaiting payment, reported, confirmed) does.
  const duplicate = db.findOtherActiveSubscriptionForBvnAndOffer(
    verifiedBvn.value,
    req.params.offerId,
    subscription.id
  );
  if (duplicate && applyUrl && duplicate.status === "SENT_TO_NGX") {
    // Already handed over to NGX - they likely closed the tab before paying.
    // Send them back rather than blocking them, without leaving a second record:
    // refresh their contact details on the existing one and drop this empty one.
    db.upsertSubscriberByBvn(subscriberFields);
    db.deleteSubscription(subscription.id);
    req.session.subscriptionId = duplicate.id;
    req.session.verifiedBvn = null;
    req.session.verifiedNin = null;
    return res.redirect(applyUrl);
  }
  if (duplicate) {
    req.flash(
      "error",
      `You already have an application for ${subscription.offer.name} (ref. ${duplicate.reference}, status: ` +
        `${duplicate.status.replace("_", " ").toLowerCase()}). Only one application per offer is allowed - ` +
        `please wait for that one to be processed.`
    );
    return res.redirect(`/offers/${req.params.offerId}`);
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

  const subscriber = db.upsertSubscriberByBvn(subscriberFields);

  if (applyUrl) {
    // Details collected: record the hand-over so the back office can follow the
    // application to NGX, then send the investor there.
    const handedOverAt = new Date();
    db.updateSubscription(subscription.id, {
      subscriberId: subscriber.id,
      isForMinor,
      minorId,
      status: "SENT_TO_NGX",
      consentAcceptedAt: handedOverAt,
      ngxRedirectedAt: handedOverAt,
    });
    req.session.verifiedBvn = null;
    req.session.verifiedNin = null;
    return res.redirect(applyUrl);
  }

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
  async (req, res) => {
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
    const bank = bankDetails();

    const updated = db.updateSubscription(subscription.id, {
      numberOfShares: shares,
      amount,
      paymentMethod: "BANK_TRANSFER",
      status: "AWAITING_PAYMENT",
      consentAcceptedAt: new Date(),
    });

    await notifySubscriber(updated, {
      subject: "Complete your Trinity Securities subscription - payment details",
      message:
        `Your subscription (ref. ${updated.reference}) for ${shares.toLocaleString()} shares in ${offer.name} ` +
        `is ready for payment. Amount: ${offer.currency}${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}. ` +
        `Transfer to ${bank.bankName}, account ${bank.accountNumber} (${bank.accountName}), and use ${updated.reference} ` +
        `as your transfer narration.`,
    });

    res.redirect(`/offers/${req.params.offerId}/subscribe/participation`);
  }
);

router.post(
  "/participation/report-payment",
  loadSubscription(STATUS_ORDER.indexOf("AWAITING_PAYMENT"), STATUS_ORDER),
  async (req, res) => {
    const { subscription } = req;
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
