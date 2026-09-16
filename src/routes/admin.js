const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAdmin, requirePermission } = require("../middleware/adminAuth");
const { handleAvatarUpload, deleteAvatarFile } = require("../middleware/upload");
const { roleOptions } = require("../services/permissions");
const mailer = require("../services/mailer");
const receipt = require("../services/receipt");
const { generateSubscriptionReference } = require("../services/reference");
const { notifySubscriber } = require("../services/notifications");
const push = require("../services/push");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// Every /admin/* response carries session-scoped or otherwise sensitive
// content, so it must never be cached by an intermediary proxy (this box's
// cPanel/nginx reverse-proxy cache in particular, which by default caches
// 200/301/302 responses for an hour with no notion of our session cookie).
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  next();
});

// ---------- Auth ----------

router.get("/login", (req, res) => {
  if (req.session.adminId) return res.redirect("/admin");
  res.render("admin/login", { title: "Admin Login", layout: "admin-layout" });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const admin = db.findAdminByEmail((email || "").trim().toLowerCase());

  if (!admin || admin.status !== "ACTIVE" || !(await bcrypt.compare(password || "", admin.passwordHash))) {
    req.flash("error", "Invalid email or password.");
    return res.redirect("/admin/login");
  }

  req.session.adminId = admin.id;
  req.session.adminName = admin.name;
  req.session.adminRole = admin.role;
  res.redirect("/admin");
});

router.post("/logout", (req, res) => {
  req.session.adminId = null;
  res.redirect("/admin/login");
});

// ---------- My profile (any signed-in admin) ----------

router.get("/profile", requireAdmin, (req, res) => {
  res.render("admin/profile", { title: "My Profile", layout: "admin-layout" });
});

router.post("/profile", requireAdmin, handleAvatarUpload, async (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const admin = db.getAdminById(req.session.adminId);

  if (!name || !email) {
    req.flash("error", "Name and email are required.");
    return res.redirect("/admin/profile");
  }
  if (!(await bcrypt.compare(req.body.currentPassword || "", admin.passwordHash))) {
    req.flash("error", "Current password is incorrect.");
    if (req.file) deleteAvatarFile(`/uploads/avatars/${req.file.filename}`);
    return res.redirect("/admin/profile");
  }
  if (email !== admin.email) {
    const existing = db.findAdminByEmail(email);
    if (existing && existing.id !== admin.id) {
      req.flash("error", "That email is already in use by another admin.");
      if (req.file) deleteAvatarFile(`/uploads/avatars/${req.file.filename}`);
      return res.redirect("/admin/profile");
    }
  }

  const avatarUrl = req.file ? `/uploads/avatars/${req.file.filename}` : undefined;
  if (avatarUrl) deleteAvatarFile(admin.avatarUrl);

  db.updateAdminProfile(admin.id, { name, email, avatarUrl });
  req.session.adminName = name;
  req.flash("success", "Profile updated.");
  res.redirect("/admin/profile");
});

router.post("/profile/password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const admin = db.getAdminById(req.session.adminId);

  if (!(await bcrypt.compare(currentPassword || "", admin.passwordHash))) {
    req.flash("error", "Current password is incorrect.");
    return res.redirect("/admin/profile");
  }
  if (!newPassword || newPassword.length < 8) {
    req.flash("error", "New password must be at least 8 characters.");
    return res.redirect("/admin/profile");
  }
  if (newPassword !== confirmPassword) {
    req.flash("error", "New passwords do not match.");
    return res.redirect("/admin/profile");
  }

  db.updateAdminPassword(admin.id, await bcrypt.hash(newPassword, 10));
  req.flash("success", "Password changed.");
  res.redirect("/admin/profile");
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

// ---------- Executive Dashboard ----------

router.get("/executive", requireAdmin, requirePermission("view_executive_dashboard"), (req, res) => {
  const offerSummaries = db.getOfferSummaries();
  const counts = db.countSubscriptionsByStatus();
  const totalConfirmedAmount = offerSummaries.reduce((sum, o) => sum + o.confirmedAmount, 0);
  const totalConfirmedCount = offerSummaries.reduce((sum, o) => sum + o.confirmedCount, 0);

  res.render("admin/executive", {
    title: "Executive Dashboard",
    layout: "admin-layout",
    offerSummaries,
    counts,
    totalConfirmedAmount,
    totalConfirmedCount,
  });
});

// ---------- Offers CRUD ----------

router.get("/offers/new", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  res.render("admin/offer-form", { title: "New Offer", layout: "admin-layout", offer: null });
});

router.post("/offers", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  db.createOffer(offerDataFromBody(req.body));
  req.flash("success", "Offer created.");
  res.redirect("/admin");
});

router.get("/offers/:id/edit", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  const offer = db.getOfferById(req.params.id);
  if (!offer) {
    req.flash("error", "Offer not found.");
    return res.redirect("/admin");
  }
  res.render("admin/offer-form", { title: "Edit Offer", layout: "admin-layout", offer });
});

router.post("/offers/:id", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  db.updateOffer(req.params.id, offerDataFromBody(req.body));
  req.flash("success", "Offer updated.");
  res.redirect("/admin");
});

router.post("/offers/:id/status", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  db.updateOfferStatus(req.params.id, req.body.status);
  req.flash("success", "Offer status updated.");
  res.redirect("/admin");
});

router.post("/offers/:id/delete", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  const offer = db.getOfferById(req.params.id);
  if (!offer) {
    req.flash("error", "Offer not found.");
    return res.redirect("/admin");
  }
  try {
    db.deleteOffer(offer.id);
    req.flash("success", `"${offer.name}" deleted.`);
  } catch (err) {
    req.flash("error", err.message);
  }
  res.redirect("/admin");
});

router.get("/offers/export.csv", requireAdmin, requirePermission("manage_offers"), (req, res) => {
  const offers = db.listOffers();
  const columns = [
    "name",
    "issuer",
    "status",
    "currency",
    "pricePerShare",
    "minimumShares",
    "multipleOf",
    "maximumShares",
    "referralRequired",
    "opensAt",
    "closesAt",
    "createdAt",
  ];
  const csvEscape = (value) => `"${String(value === null || value === undefined ? "" : value).replace(/"/g, '""')}"`;
  const rows = offers.map((offer) =>
    columns
      .map((col) => {
        const value = offer[col];
        if (value instanceof Date) return csvEscape(value.toISOString());
        return csvEscape(value);
      })
      .join(",")
  );
  const csv = [columns.map(csvEscape).join(","), ...rows].join("\r\n");

  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="offers-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(csv);
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

// ---------- News & Analysis CRUD ----------

router.get("/news", requireAdmin, (req, res) => {
  res.render("admin/news-list", { title: "News & Analysis", layout: "admin-layout", articles: db.listNews() });
});

router.get("/news/new", requireAdmin, requirePermission("manage_news"), (req, res) => {
  res.render("admin/news-form", { title: "New Article", layout: "admin-layout", article: null });
});

router.post("/news", requireAdmin, requirePermission("manage_news"), (req, res) => {
  db.createNews(newsDataFromBody(req.body));
  req.flash("success", "Article saved.");
  res.redirect("/admin/news");
});

router.get("/news/:id/edit", requireAdmin, requirePermission("manage_news"), (req, res) => {
  const article = db.getNewsById(req.params.id);
  if (!article) {
    req.flash("error", "Article not found.");
    return res.redirect("/admin/news");
  }
  res.render("admin/news-form", { title: "Edit Article", layout: "admin-layout", article });
});

router.post("/news/:id", requireAdmin, requirePermission("manage_news"), (req, res) => {
  db.updateNews(req.params.id, newsDataFromBody(req.body));
  req.flash("success", "Article updated.");
  res.redirect("/admin/news");
});

router.post("/news/:id/delete", requireAdmin, requirePermission("manage_news"), (req, res) => {
  db.deleteNews(req.params.id);
  req.flash("success", "Article deleted.");
  res.redirect("/admin/news");
});

function newsDataFromBody(body) {
  return {
    title: body.title,
    category: body.category || "NEWS",
    summary: body.summary || null,
    body: body.body || null,
    imageUrl: body.imageUrl || null,
    author: body.author || null,
    status: body.status || "DRAFT",
  };
}

// ---------- Stock Recommendations CRUD ----------

router.get("/recommendations", requireAdmin, (req, res) => {
  res.render("admin/recommendations-list", {
    title: "Stock Recommendations",
    layout: "admin-layout",
    recommendations: db.listRecommendations(),
  });
});

router.get("/recommendations/new", requireAdmin, requirePermission("manage_recommendations"), (req, res) => {
  res.render("admin/recommendation-form", { title: "New Recommendation", layout: "admin-layout", recommendation: null });
});

router.post("/recommendations", requireAdmin, requirePermission("manage_recommendations"), (req, res) => {
  db.createRecommendation(recommendationDataFromBody(req.body));
  req.flash("success", "Recommendation saved.");
  res.redirect("/admin/recommendations");
});

router.get("/recommendations/:id/edit", requireAdmin, requirePermission("manage_recommendations"), (req, res) => {
  const recommendation = db.getRecommendationById(req.params.id);
  if (!recommendation) {
    req.flash("error", "Recommendation not found.");
    return res.redirect("/admin/recommendations");
  }
  res.render("admin/recommendation-form", { title: "Edit Recommendation", layout: "admin-layout", recommendation });
});

router.post("/recommendations/:id", requireAdmin, requirePermission("manage_recommendations"), (req, res) => {
  db.updateRecommendation(req.params.id, recommendationDataFromBody(req.body));
  req.flash("success", "Recommendation updated.");
  res.redirect("/admin/recommendations");
});

router.post("/recommendations/:id/delete", requireAdmin, requirePermission("manage_recommendations"), (req, res) => {
  db.deleteRecommendation(req.params.id);
  req.flash("success", "Recommendation deleted.");
  res.redirect("/admin/recommendations");
});

function recommendationDataFromBody(body) {
  return {
    stockCode: (body.stockCode || "").toUpperCase(),
    stockName: body.stockName || null,
    rating: body.rating || "HOLD",
    targetPrice: body.targetPrice ? parseFloat(body.targetPrice) : null,
    rationale: body.rationale || null,
    analyst: body.analyst || null,
    status: body.status || "DRAFT",
  };
}

// ---------- Adverts CRUD (in-app banners + push notifications) ----------

router.get("/adverts", requireAdmin, (req, res) => {
  res.render("admin/adverts-list", {
    title: "Adverts",
    layout: "admin-layout",
    adverts: db.listAdverts(),
    pushMode: push.MODE,
  });
});

router.get("/adverts/new", requireAdmin, requirePermission("manage_adverts"), (req, res) => {
  res.render("admin/advert-form", { title: "New Advert", layout: "admin-layout", advert: null });
});

router.post("/adverts", requireAdmin, requirePermission("manage_adverts"), (req, res) => {
  db.createAdvert(advertDataFromBody(req.body));
  req.flash("success", "Advert saved.");
  res.redirect("/admin/adverts");
});

router.get("/adverts/:id/edit", requireAdmin, requirePermission("manage_adverts"), (req, res) => {
  const advert = db.getAdvertById(req.params.id);
  if (!advert) {
    req.flash("error", "Advert not found.");
    return res.redirect("/admin/adverts");
  }
  res.render("admin/advert-form", { title: "Edit Advert", layout: "admin-layout", advert });
});

router.post("/adverts/:id", requireAdmin, requirePermission("manage_adverts"), (req, res) => {
  db.updateAdvert(req.params.id, advertDataFromBody(req.body));
  req.flash("success", "Advert updated.");
  res.redirect("/admin/adverts");
});

router.post("/adverts/:id/status", requireAdmin, requirePermission("manage_adverts"), (req, res) => {
  db.updateAdvertStatus(req.params.id, req.body.status);
  req.flash("success", "Advert status updated.");
  res.redirect("/admin/adverts");
});

router.post("/adverts/:id/delete", requireAdmin, requirePermission("manage_adverts"), (req, res) => {
  db.deleteAdvert(req.params.id);
  req.flash("success", "Advert deleted.");
  res.redirect("/admin/adverts");
});

// Push send is separate from status: an advert can be ACTIVE as a pure
// banner without ever being pushed, and once pushed it stays visible in the
// app's notification inbox (GET /api/adverts) regardless of PUSH_MODE.
router.post("/adverts/:id/send", requireAdmin, requirePermission("send_adverts"), async (req, res) => {
  const advert = db.getAdvertById(req.params.id);
  if (!advert) {
    req.flash("error", "Advert not found.");
    return res.redirect("/admin/adverts");
  }
  if (advert.placement === "BANNER") {
    req.flash("error", "This advert is banner-only - switch its placement to Notification or Both to send it.");
    return res.redirect("/admin/adverts");
  }
  try {
    const result = await push.sendAdvertPush(advert);
    db.markAdvertSent(advert.id);
    req.flash(
      "success",
      `Sent to ${result.sent} device(s)${result.failed ? `, ${result.failed} failed` : ""} (${result.mode} mode).`
    );
  } catch (err) {
    req.flash("error", `Could not send: ${err.message}`);
  }
  res.redirect("/admin/adverts");
});

function advertDataFromBody(body) {
  return {
    title: body.title,
    message: body.message || null,
    imageUrl: body.imageUrl || null,
    linkUrl: body.linkUrl || null,
    placement: body.placement || "BANNER",
    status: body.status || "DRAFT",
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
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

// BVN/NIN are masked here (and in the CSV export below) even though every
// role can reach this list - NDPA-sensitive identifiers stay reserved for
// the Edit form, which only Super Admin can open.
function maskId(value) {
  if (!value || value.length < 6) return value || "";
  return `${value.slice(0, 3)}${"*".repeat(value.length - 5)}${value.slice(-2)}`;
}

router.get("/subscriptions/export.csv", requireAdmin, (req, res) => {
  const statusFilter = req.query.status;
  const subscriptions = db.listSubscriptions({ status: statusFilter || undefined });
  const columns = [
    "reference",
    "status",
    "offerName",
    "subscriberName",
    "bvnMasked",
    "email",
    "phone",
    "trinityAccountId",
    "isForMinor",
    "minorName",
    "minorNinMasked",
    "numberOfShares",
    "amount",
    "currency",
    "paymentMethod",
    "referralCode",
    "consentAcceptedAt",
    "transferReportedAt",
    "confirmedAt",
    "confirmedBy",
    "createdAt",
  ];
  const csvEscape = (value) => `"${String(value === null || value === undefined ? "" : value).replace(/"/g, '""')}"`;
  const rows = subscriptions.map((sub) => {
    const row = {
      reference: sub.reference,
      status: sub.status,
      offerName: sub.offer.name,
      subscriberName: sub.subscriber ? sub.subscriber.fullName : "",
      bvnMasked: sub.subscriber ? maskId(sub.subscriber.bvn) : "",
      email: sub.subscriber ? sub.subscriber.email || "" : "",
      phone: sub.subscriber ? sub.subscriber.phone || "" : "",
      trinityAccountId: sub.subscriber ? sub.subscriber.trinityAccountId || "" : "",
      isForMinor: sub.isForMinor ? "Yes" : "No",
      minorName: sub.minor ? sub.minor.fullName : "",
      minorNinMasked: sub.minor ? maskId(sub.minor.nin) : "",
      numberOfShares: sub.numberOfShares,
      amount: sub.amount,
      currency: sub.offer.currency,
      paymentMethod: sub.paymentMethod,
      referralCode: sub.referralCode,
      consentAcceptedAt: sub.consentAcceptedAt ? sub.consentAcceptedAt.toISOString() : "",
      transferReportedAt: sub.transferReportedAt ? sub.transferReportedAt.toISOString() : "",
      confirmedAt: sub.confirmedAt ? sub.confirmedAt.toISOString() : "",
      confirmedBy: sub.confirmedBy,
      createdAt: sub.createdAt.toISOString(),
    };
    return columns.map((col) => csvEscape(row[col])).join(",");
  });
  const csv = [columns.map(csvEscape).join(","), ...rows].join("\r\n");

  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="subscriptions-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(csv);
});

router.get("/subscriptions/new", requireAdmin, requirePermission("manage_subscriptions"), (req, res) => {
  res.render("admin/subscription-form", {
    title: "New Subscription",
    layout: "admin-layout",
    offers: db.listOffers(),
  });
});

router.post("/subscriptions", requireAdmin, requirePermission("manage_subscriptions"), (req, res) => {
  const offer = db.getOfferById(req.body.offerId);
  if (!offer) {
    req.flash("error", "Select a valid offer.");
    return res.redirect("/admin/subscriptions/new");
  }

  const fullName = (req.body.fullName || "").trim();
  const bvn = (req.body.bvn || "").trim();
  const contactDestination = (req.body.contactDestination || "").trim();
  const isForMinor = req.body.subscriptionFor === "minor";
  const shares = parseInt(req.body.numberOfShares, 10);

  if (!fullName || !/^\d{11}$/.test(bvn)) {
    req.flash("error", "Enter the investor's full name and an 11-digit BVN.");
    return res.redirect("/admin/subscriptions/new");
  }
  if (!contactDestination) {
    req.flash("error", "Enter the investor's email or phone number.");
    return res.redirect("/admin/subscriptions/new");
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
    return res.redirect("/admin/subscriptions/new");
  }

  let minorId = null;
  if (isForMinor) {
    const minorName = (req.body.minorFullName || "").trim();
    const minorNin = (req.body.minorNin || "").trim();
    if (!minorName || !/^\d{11}$/.test(minorNin)) {
      req.flash("error", "Enter the minor's full name and an 11-digit NIN.");
      return res.redirect("/admin/subscriptions/new");
    }
    minorId = db.createMinor({ nin: minorNin, fullName: minorName }).id;
  }

  const subscriber = db.upsertSubscriberByBvn({
    bvn,
    fullName,
    email: EMAIL_RE.test(contactDestination) ? contactDestination : null,
    phone: EMAIL_RE.test(contactDestination) ? null : contactDestination,
    trinityAccountId: (req.body.trinityAccountId || "").trim() || null,
  });

  const alreadyConfirmed = req.body.status === "CONFIRMED";
  const subscription = db.createSubscription({
    offerId: offer.id,
    reference: generateSubscriptionReference(),
    referralCode: (req.body.referralCode || "").trim() || null,
  });
  db.updateSubscription(subscription.id, {
    subscriberId: subscriber.id,
    isForMinor,
    minorId,
    numberOfShares: shares,
    amount: shares * offer.pricePerShare,
    paymentMethod: "BANK_TRANSFER",
    status: alreadyConfirmed ? "CONFIRMED" : "PAYMENT_REPORTED",
    consentAcceptedAt: new Date(),
    transferReportedAt: new Date(),
    ...(alreadyConfirmed ? { confirmedAt: new Date(), confirmedBy: req.session.adminName } : {}),
  });

  req.flash("success", `Subscription ${subscription.reference} created for ${fullName}.`);
  res.redirect("/admin/subscriptions");
});

router.get("/subscriptions/:id", requireAdmin, (req, res) => {
  const subscription = db.getSubscriptionById(req.params.id);
  if (!subscription) {
    req.flash("error", "Subscription not found.");
    return res.redirect("/admin/subscriptions");
  }
  res.render("admin/subscription-detail", {
    title: "Subscription Details",
    layout: "admin-layout",
    subscription,
    maskId,
  });
});

router.get("/subscriptions/:id/edit", requireAdmin, requirePermission("edit_delete_subscriptions"), (req, res) => {
  const subscription = db.getSubscriptionById(req.params.id);
  if (!subscription) {
    req.flash("error", "Subscription not found.");
    return res.redirect("/admin/subscriptions");
  }
  res.render("admin/subscription-form", {
    title: "Edit Subscription",
    layout: "admin-layout",
    offers: db.listOffers(),
    subscription,
  });
});

router.post("/subscriptions/:id", requireAdmin, requirePermission("edit_delete_subscriptions"), (req, res) => {
  const subscription = db.getSubscriptionById(req.params.id);
  if (!subscription) {
    req.flash("error", "Subscription not found.");
    return res.redirect("/admin/subscriptions");
  }
  const offer = subscription.offer; // the offer itself isn't editable here - see subscription-form.ejs

  const fullName = (req.body.fullName || "").trim();
  const bvn = (req.body.bvn || "").trim();
  const contactDestination = (req.body.contactDestination || "").trim();
  const isForMinor = req.body.subscriptionFor === "minor";
  const shares = parseInt(req.body.numberOfShares, 10);

  if (!fullName || !/^\d{11}$/.test(bvn)) {
    req.flash("error", "Enter the investor's full name and an 11-digit BVN.");
    return res.redirect(`/admin/subscriptions/${subscription.id}/edit`);
  }
  if (!contactDestination) {
    req.flash("error", "Enter the investor's email or phone number.");
    return res.redirect(`/admin/subscriptions/${subscription.id}/edit`);
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
    return res.redirect(`/admin/subscriptions/${subscription.id}/edit`);
  }

  let minorId = subscription.minorId;
  if (isForMinor) {
    const minorName = (req.body.minorFullName || "").trim();
    const minorNin = (req.body.minorNin || "").trim();
    if (!minorName || !/^\d{11}$/.test(minorNin)) {
      req.flash("error", "Enter the minor's full name and an 11-digit NIN.");
      return res.redirect(`/admin/subscriptions/${subscription.id}/edit`);
    }
    minorId = subscription.minorId
      ? db.updateMinor(subscription.minorId, { nin: minorNin, fullName: minorName }).id
      : db.createMinor({ nin: minorNin, fullName: minorName }).id;
  }

  if (subscription.subscriberId) {
    try {
      db.updateSubscriber(subscription.subscriberId, {
        fullName,
        bvn,
        email: EMAIL_RE.test(contactDestination) ? contactDestination : null,
        phone: EMAIL_RE.test(contactDestination) ? null : contactDestination,
        trinityAccountId: (req.body.trinityAccountId || "").trim() || null,
      });
    } catch (err) {
      req.flash("error", "That BVN is already used by another subscriber.");
      return res.redirect(`/admin/subscriptions/${subscription.id}/edit`);
    }
  }

  db.updateSubscription(subscription.id, {
    isForMinor,
    minorId: isForMinor ? minorId : null,
    numberOfShares: shares,
    amount: shares * offer.pricePerShare,
    referralCode: (req.body.referralCode || "").trim() || null,
  });

  req.flash("success", `Subscription ${subscription.reference} updated.`);
  res.redirect("/admin/subscriptions");
});

router.post("/subscriptions/:id/confirm", requireAdmin, requirePermission("confirm_payment"), async (req, res) => {
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

router.post("/subscriptions/:id/reject", requireAdmin, requirePermission("confirm_payment"), async (req, res) => {
  const subscription = db.updateSubscription(req.params.id, { status: "REJECTED" });
  await notifySubscriber(subscription, {
    subject: "Your subscription could not be confirmed",
    message: `Your subscription (ref. ${subscription.reference}) for ${subscription.offer.name} could not be confirmed. Please contact Trinity Securities Limited for details.`,
  });
  req.flash("success", "Subscription rejected.");
  res.redirect("/admin/subscriptions");
});

router.post("/subscriptions/:id/unconfirm", requireAdmin, requirePermission("unconfirm_payment"), async (req, res) => {
  const existing = db.getSubscriptionById(req.params.id);
  if (!existing || existing.status !== "CONFIRMED") {
    req.flash("error", "Only a confirmed subscription can be unconfirmed.");
    return res.redirect("/admin/subscriptions");
  }

  const subscription = db.updateSubscription(existing.id, {
    status: "PAYMENT_REPORTED",
    confirmedAt: null,
    confirmedBy: null,
  });
  await notifySubscriber(subscription, {
    subject: "Your subscription is being re-reviewed",
    message: `Your subscription (ref. ${subscription.reference}) for ${subscription.offer.name} has been moved back to review. Our team will follow up with you shortly.`,
  });
  req.flash("success", `Subscription ${subscription.reference} unconfirmed - back in the review queue.`);
  res.redirect("/admin/subscriptions");
});

router.post("/subscriptions/:id/delete", requireAdmin, requirePermission("edit_delete_subscriptions"), (req, res) => {
  const subscription = db.getSubscriptionById(req.params.id);
  if (!subscription) {
    req.flash("error", "Subscription not found.");
    return res.redirect("/admin/subscriptions");
  }
  db.deleteSubscription(subscription.id);
  req.flash("success", `Subscription ${subscription.reference} deleted.`);
  res.redirect("/admin/subscriptions");
});

router.post("/subscriptions/batch-delete", requireAdmin, requirePermission("edit_delete_subscriptions"), (req, res) => {
  const ids = [].concat(req.body.ids || []).filter(Boolean);
  if (!ids.length) {
    req.flash("error", "Select at least one subscription to delete.");
    return res.redirect("/admin/subscriptions");
  }
  const count = db.deleteSubscriptions(ids);
  req.flash("success", `${count} subscription${count === 1 ? "" : "s"} deleted.`);
  res.redirect("/admin/subscriptions");
});

// A receipt only makes sense once a subscription is actually CONFIRMED.
function loadConfirmedSubscription(req, res) {
  const subscription = db.getSubscriptionById(req.params.id);
  if (!subscription || subscription.status !== "CONFIRMED") {
    req.flash("error", "Receipts are only available for confirmed subscriptions.");
    res.redirect("/admin/subscriptions");
    return null;
  }
  return subscription;
}

router.get("/subscriptions/:id/receipt.pdf", requireAdmin, requirePermission("manage_subscriptions"), async (req, res) => {
  const subscription = loadConfirmedSubscription(req, res);
  if (!subscription) return;

  const pdfBuffer = await receipt.renderReceiptPdf(receipt.buildReceiptData(subscription));
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="Receipt-${subscription.reference}.pdf"`,
  });
  res.send(pdfBuffer);
});

router.post("/subscriptions/:id/receipt/email", requireAdmin, requirePermission("manage_subscriptions"), async (req, res) => {
  const subscription = loadConfirmedSubscription(req, res);
  if (!subscription) return;

  const investorEmail = subscription.subscriber && subscription.subscriber.email;
  if (!investorEmail) {
    req.flash("error", "This investor has no email on file (they verified by phone) - nothing to send to.");
    return res.redirect("/admin/subscriptions");
  }

  const data = receipt.buildReceiptData(subscription);
  try {
    const pdfBuffer = await receipt.renderReceiptPdf(data);
    const result = await mailer.sendEmail({
      to: investorEmail,
      toName: data.investorName,
      subject: `Your payment receipt - ${data.receiptNo}`,
      html: receipt.renderReceiptHtml(data),
      attachments: [{ filename: `Receipt-${data.receiptNo}.pdf`, content: pdfBuffer }],
    });
    if (!result.sent) {
      req.flash("error", `Could not send the receipt: ${result.message || "unknown error"}`);
    } else {
      req.flash("success", `Receipt emailed to ${investorEmail}.`);
    }
  } catch (err) {
    console.error("Receipt email failed:", err.message);
    req.flash("error", "Could not send the receipt. Please try again.");
  }
  res.redirect("/admin/subscriptions");
});

function generateTempPassword() {
  return crypto.randomBytes(18).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

// Emails a freshly (re)generated password straight to the admin it belongs
// to - not just to whoever clicked the button - so there's one source of
// truth for it and nobody has to relay it by hand. Falls back to showing
// it in the flash message if the send itself fails, so it's never lost.
async function sendCredentialsEmail(admin, tempPassword, { subject, intro }) {
  const result = await mailer.sendEmail({
    to: admin.email,
    toName: admin.name,
    subject,
    html:
      `<p>${intro}</p>` +
      `<p>Email: ${admin.email}<br/>Password: ${tempPassword}</p>` +
      `<p>Please log in and change this password immediately.</p>`,
  });
  return result.sent;
}

// ---------- Admin users (roles & permissions) ----------

router.get("/users", requireAdmin, requirePermission("manage_admins"), (req, res) => {
  res.render("admin/users", {
    title: "Admin Users",
    layout: "admin-layout",
    adminUsers: db.listAdminUsers(),
  });
});

router.get("/users/new", requireAdmin, requirePermission("manage_admins"), (req, res) => {
  res.render("admin/user-form", {
    title: "New Admin",
    layout: "admin-layout",
    adminUser: null,
    roles: roleOptions(),
  });
});

router.post("/users", requireAdmin, requirePermission("manage_admins"), async (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const role = req.body.role;

  if (!name || !email || !roleOptions().some((r) => r.value === role)) {
    req.flash("error", "Please fill in all fields with a valid role.");
    return res.redirect("/admin/users/new");
  }
  if (db.findAdminByEmail(email)) {
    req.flash("error", "An admin with that email already exists.");
    return res.redirect("/admin/users/new");
  }

  const tempPassword = generateTempPassword();
  const admin = db.createAdminUser({ name, email, role, passwordHash: await bcrypt.hash(tempPassword, 10) });

  const emailed = await sendCredentialsEmail(admin, tempPassword, {
    subject: "Your Trinity Securities admin account",
    intro: "An admin account has been created for you on the Trinity Securities Offers Portal.",
  });

  req.flash(
    "success",
    `Admin created: ${email} / ${tempPassword}` +
      (emailed ? " (also emailed to them)." : " - could not email it, share this securely.")
  );
  res.redirect("/admin/users");
});

router.get("/users/:id/edit", requireAdmin, requirePermission("manage_admins"), (req, res) => {
  const adminUser = db.getAdminById(req.params.id);
  if (!adminUser) {
    req.flash("error", "Admin user not found.");
    return res.redirect("/admin/users");
  }
  res.render("admin/user-form", {
    title: "Edit Admin",
    layout: "admin-layout",
    adminUser,
    roles: roleOptions(),
  });
});

router.post("/users/:id", requireAdmin, requirePermission("manage_admins"), (req, res) => {
  const target = db.getAdminById(req.params.id);
  if (!target) {
    req.flash("error", "Admin user not found.");
    return res.redirect("/admin/users");
  }

  const role = req.body.role;
  const status = req.body.status === "DISABLED" ? "DISABLED" : "ACTIVE";
  const name = (req.body.name || target.name).trim();

  if (target.id === req.session.adminId && (role !== target.role || status !== target.status)) {
    req.flash("error", "You cannot change your own role or status.");
    return res.redirect("/admin/users");
  }

  const wouldRemoveLastSuperAdmin =
    target.role === "SUPER_ADMIN" &&
    target.status === "ACTIVE" &&
    (role !== "SUPER_ADMIN" || status !== "ACTIVE") &&
    db.countActiveAdminsByRole("SUPER_ADMIN") <= 1;

  if (wouldRemoveLastSuperAdmin) {
    req.flash("error", "At least one active Super Admin is required.");
    return res.redirect("/admin/users");
  }

  db.updateAdminUser(target.id, { name, role, status });
  req.flash("success", "Admin user updated.");
  res.redirect("/admin/users");
});

router.post("/users/:id/reset-password", requireAdmin, requirePermission("manage_admins"), async (req, res) => {
  const target = db.getAdminById(req.params.id);
  if (!target) {
    req.flash("error", "Admin user not found.");
    return res.redirect("/admin/users");
  }

  const tempPassword = generateTempPassword();
  db.updateAdminPassword(target.id, await bcrypt.hash(tempPassword, 10));

  const emailed = await sendCredentialsEmail(target, tempPassword, {
    subject: "Your Trinity Securities admin password has been reset",
    intro: "Your admin password on the Trinity Securities Offers Portal has been reset.",
  });

  req.flash(
    "success",
    `Password reset for ${target.email}: ${tempPassword}` +
      (emailed ? " (also emailed to them)." : " - could not email it, share this securely.")
  );
  res.redirect("/admin/users");
});

module.exports = router;
