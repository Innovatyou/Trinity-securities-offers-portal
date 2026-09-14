const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAdmin, requirePermission } = require("../middleware/adminAuth");
const { handleAvatarUpload, deleteAvatarFile } = require("../middleware/upload");
const { roleOptions } = require("../services/permissions");
const veltrix = require("../services/veltrixClient");
const mailer = require("../services/mailer");
const receipt = require("../services/receipt");

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

// ---------- Subscriptions ----------

router.get("/subscriptions", requireAdmin, requirePermission("manage_subscriptions"), (req, res) => {
  const statusFilter = req.query.status;
  const subscriptions = db.listSubscriptions({ status: statusFilter || undefined });
  res.render("admin/subscriptions", {
    title: "Subscriptions",
    layout: "admin-layout",
    subscriptions,
    statusFilter: statusFilter || "",
  });
});

router.post("/subscriptions/:id/confirm", requireAdmin, requirePermission("manage_subscriptions"), async (req, res) => {
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

router.post("/subscriptions/:id/reject", requireAdmin, requirePermission("manage_subscriptions"), async (req, res) => {
  const subscription = db.updateSubscription(req.params.id, { status: "REJECTED" });
  await notifySubscriber(subscription, {
    subject: "Your subscription could not be confirmed",
    message: `Your subscription (ref. ${subscription.reference}) for ${subscription.offer.name} could not be confirmed. Please contact Trinity Securities Limited for details.`,
  });
  req.flash("success", "Subscription rejected.");
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
  db.createAdminUser({ name, email, role, passwordHash: await bcrypt.hash(tempPassword, 10) });

  req.flash(
    "success",
    `Admin created: ${email} / ${tempPassword} - share this securely, it will not be shown again.`
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

  req.flash(
    "success",
    `Password reset for ${target.email}: ${tempPassword} - share this securely, it will not be shown again.`
  );
  res.redirect("/admin/users");
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
      await mailer.sendEmail({ to: subscriber.email, toName: subscriber.fullName, subject, html: `<p>${message}</p>` });
    }
    if (subscriber.phone) {
      await veltrix.sendSms({ to: subscriber.phone, message });
    }
  } catch (err) {
    console.error("Subscriber notification failed:", err.message);
  }
}

module.exports = router;
