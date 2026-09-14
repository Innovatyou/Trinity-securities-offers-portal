function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  req.flash("error", "Please sign in to continue.");
  return res.redirect("/admin/login");
}

module.exports = { requireAdmin };
