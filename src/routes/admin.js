const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAdmin } = require("../middleware/adminAuth");
const veltrix = require("../services/veltrixClient");

const router = express.Router();

// ---------- Auth ----------

router.get("/login", (req, res) => {
  if (req.session.adminId) return res.redirect("/admin");
  res.render("admin/login", { title: "Admin Login", layout: "admin-layout" });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const admin = db.findAdminByEmail((email || "").trim().toLowerCase());

  if (!admin || !(await bcrypt.compare(password || "", admin.passwordHash))) {
    req.flash("error", "Invalid email or password.");
    return res.redirect("/admin/login");
  }

  req.session.adminId = admin.id;
  req.session.adminName = admin.name;
  res.redirect("/admin");
});

router.post("/logout", (req, res) => {
  req.session.adminId = null;
  res.redirect("/admin/login");
});

// ---------- Dashboard ----------

router.get("/", requireAdmin, (req, res) => {
  const offers = db.listOffers();
  const counts = db.countSubscriptionsByStatus();

  res.render("admin/dashboard", {
    title: "Dashboard",
    layout: "admin-layout",
    offers,
    counts,
  });
});

// ---------- Offers CRUD ----------

router.get("/offers/new", requireAdmin, (req, res) => {
  res.render("admin/offer-form", { title: "New Offer", layout: "admin-layout", offer: null });
});

router.post("/offers", requireAdmin, (req, res) => {
  db.createOffer(offerDataFromBody(req.body));
  req.flash("success", "Offer created.");
  res.redirect("/admin");
});

router.get("/offers/:id/edit", requireAdmin, (req, res) => {
  const offer = db.getOfferById(req.params.id);
  if (!offer) {
    req.flash("error", "Offer not found.");
    return res.redirect("/admin");
  }
  res.render("admin/offer-form", { title: "Edit Offer", layout: "admin-layout", offer });
});

router.post("/offers/:id", requireAdmin, (req, res) => {
  db.updateOffer(req.params.id, offerDataFromBody(req.body));
  req.flash("success", "Offer updated.");
  res.redirect("/admin");
});

router.post("/offers/:id/status", requireAdmin, (req, res) => {
  db.updateOfferStatus(req.params.id, req.body.status);
  req.flash("success", "Offer status updated.");
  res.redirect("/admin");
});

function offerDataFromBody(body) {
  return {
    name: body.name,
    issuer: body.issuer,
    summary: body.summary || null,
    pricePerShare: parseFloat(body.pricePerShare),
    minimumShares: parseInt(body.minimumShares, 10),
    multipleOf: parseInt(body.multipleOf, 10),
    maximumShares: body.maximumShares ? parseInt(body.maximumShares, 10) : null,
    closesAt: new Date(body.closesAt),
    status: body.status || "DRAFT",
    prospectusUrl: body.prospectusUrl || null,
    termSheetUrl: body.termSheetUrl || null,
    pricingSupplementUrl: body.pricingSupplementUrl || null,
    referralRequired: body.referralRequired === "on",
  };
}

// ---------- Subscriptions ----------

router.get("/subscriptions", requireAdmin, (req, res) => {
  const statusFilter = req.query.status;
  const subscriptions = db.listSubscriptions({ status: statusFilter || undefined });
  res.render("admin/subscriptions", {
    title: "Subscriptions",
    layout: "admin-layout",
    subscriptions,
    statusFilter: statusFilter || "",
  });
});

router.post("/subscriptions/:id/confirm", requireAdmin, async (req, res) => {
  const subscription = db.updateSubscription(req.params.id, {
    status: "CONFIRMED",
    confirmedAt: new Date(),
    confirmedBy: req.session.adminName,
  });
  await notifySubscriber(subscription, {
    subject: "Your subscription has been confirmed",
    message: `Your subscription (ref. ${subscription.reference}) for ${subscription.numberOfShares} shares in ${subscription.offer.name} has been confirmed. Shares will be allotted shortly.`,
  });
  req.flash("success", "Subscription marked as confirmed - shares can now be allotted.");
  res.redirect("/admin/subscriptions");
});

router.post("/subscriptions/:id/reject", requireAdmin, async (req, res) => {
  const subscription = db.updateSubscription(req.params.id, { status: "REJECTED" });
  await notifySubscriber(subscription, {
    subject: "Your subscription could not be confirmed",
    message: `Your subscription (ref. ${subscription.reference}) for ${subscription.offer.name} could not be confirmed. Please contact Trinity Securities Limited for details.`,
  });
  req.flash("success", "Subscription rejected.");
  res.redirect("/admin/subscriptions");
});

// ---------- Subscriber notifications ----------

const NOTIFY_MODE = process.env.NOTIFICATIONS_MODE || "MOCK";

/**
 * Emails/texts the subscriber behind a subscription through Veltrix.
 * NOTIFICATIONS_MODE=MOCK (default) only logs, so nothing is sent until
 * VELTRIX_API_KEY etc. are configured and NOTIFICATIONS_MODE=LIVE is set.
 * Best-effort: a failed notification never blocks the admin action.
 */
async function notifySubscriber(subscription, { subject, message }) {
  const subscriber = subscription && subscription.subscriber;
  if (!subscriber) return;

  if (NOTIFY_MODE !== "LIVE") {
    console.log(`[notify:MOCK] ${subscriber.email || subscriber.phone}: ${subject}`);
    return;
  }

  try {
    if (subscriber.email) {
      await veltrix.sendEmail({ to: subscriber.email, toName: subscriber.fullName, subject, html: `<p>${message}</p>` });
    }
    if (subscriber.phone) {
      await veltrix.sendSms({ to: subscriber.phone, message });
    }
  } catch (err) {
    console.error("Subscriber notification failed:", err.message);
  }
}

module.exports = router;
