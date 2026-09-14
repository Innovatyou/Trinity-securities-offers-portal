const db = require("../db");
const { hasPermission, roleLabel } = require("../services/permissions");

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    const admin = db.getAdminById(req.session.adminId);
    if (!admin || admin.status !== "ACTIVE") {
      req.session.adminId = null;
      req.flash("error", "Your admin access has been disabled. Contact a super admin.");
      return res.redirect("/admin/login");
    }

    req.session.adminName = admin.name;
    req.session.adminRole = admin.role;
    res.locals.currentAdmin = admin;
    res.locals.can = (permission) => hasPermission(admin.role, permission);
    res.locals.roleLabel = roleLabel;
    return next();
  }
  req.flash("error", "Please sign in to continue.");
  return res.redirect("/admin/login");
}

function requirePermission(permission) {
  return function (req, res, next) {
    if (req.session && hasPermission(req.session.adminRole, permission)) {
      return next();
    }
    req.flash("error", "You do not have permission to do that.");
    return res.redirect("/admin");
  };
}

module.exports = { requireAdmin, requirePermission };
