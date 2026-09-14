const path = require("path");
const fs = require("fs");
const multer = require("multer");

const AVATAR_DIR = path.join(__dirname, "..", "public", "uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

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

module.exports = { handleAvatarUpload, deleteAvatarFile };
