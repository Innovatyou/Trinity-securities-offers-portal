const path = require("path");
const fs = require("fs");
const multer = require("multer");

const AVATAR_DIR = path.join(__dirname, "..", "public", "uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ADVERT_DIR = path.join(__dirname, "..", "public", "uploads", "adverts");
fs.mkdirSync(ADVERT_DIR, { recursive: true });

const ALLOWED_MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    cb(null, `${req.session.adminId}-${Date.now()}${ALLOWED_MIME_EXT[file.mimetype]}`);
  },
});

const avatarUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_EXT[file.mimetype]) {
      return cb(new Error("Only PNG, JPEG, WEBP or GIF images are allowed."));
    }
    cb(null, true);
  },
});

// Wraps multer so a rejected/oversized upload becomes a flash message
// instead of a raw error bubbling to the generic 500 page.
function handleAvatarUpload(req, res, next) {
  avatarUpload.single("avatar")(req, res, (err) => {
    if (err) {
      req.flash("error", err.message || "Could not upload that file.");
      return res.redirect("/admin/profile");
    }
    next();
  });
}

function deleteAvatarFile(avatarUrl) {
  if (!avatarUrl) return;
  const filePath = path.join(__dirname, "..", "public", avatarUrl.replace(/^\/+/, ""));
  fs.unlink(filePath, () => {});
}

const advertImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ADVERT_DIR),
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ALLOWED_MIME_EXT[file.mimetype]}`);
  },
});

const advertImageUpload = multer({
  storage: advertImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_EXT[file.mimetype]) {
      return cb(new Error("Only PNG, JPEG, WEBP or GIF images are allowed."));
    }
    cb(null, true);
  },
});

// Same wrap-multer-errors-as-a-flash pattern as handleAvatarUpload, redirecting
// back to the right form (new vs edit) instead of a generic path.
function handleAdvertImageUpload(req, res, next) {
  advertImageUpload.single("bannerImage")(req, res, (err) => {
    if (err) {
      req.flash("error", err.message || "Could not upload that image.");
      return res.redirect(req.params.id ? `/admin/adverts/${req.params.id}/edit` : "/admin/adverts/new");
    }
    next();
  });
}

// Only unlinks files this app manages (under /uploads/adverts/) - a plain
// external imageUrl someone typed into the URL field is never touched.
function deleteAdvertImageFile(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/adverts/")) return;
  const filePath = path.join(__dirname, "..", "public", imageUrl.replace(/^\/+/, ""));
  fs.unlink(filePath, () => {});
}

module.exports = { handleAvatarUpload, deleteAvatarFile, handleAdvertImageUpload, deleteAdvertImageFile };
