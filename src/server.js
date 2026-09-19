require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const flash = require("connect-flash");
const expressLayouts = require("express-ejs-layouts");

const publicRoutes = require("./routes/public");
const subscribeRoutes = require("./routes/subscribe");
const adminRoutes = require("./routes/admin");
const apiRoutes = require("./routes/api");
const { ngxApplyUrl } = require("./services/ngx");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SESSION_MAX_AGE = 1000 * 60 * 60 * 2; // 2 hours

// express-session defaults to an in-memory store, which is wiped on every
// process restart (every deploy, since we `pm2 restart` after each pull) -
// that was logging every admin out regardless of the cookie's maxAge. Persist
// sessions to disk instead so a restart doesn't end anyone's session early.
app.use(
  session({
    store: new FileStore({
      path: path.join(__dirname, "..", "sessions"),
      ttl: SESSION_MAX_AGE / 1000,
      logFn: () => {}, // library logs every reap sweep to console by default - too noisy for pm2 logs
    }),
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh the 2-hour window on activity instead of hard-expiring from login time
    cookie: { maxAge: SESSION_MAX_AGE },
  })
);
app.use(flash());

// Make flash messages, current path and brand config available in every view
app.use((req, res, next) => {
  res.locals.successMessages = req.flash("success");
  res.locals.errorMessages = req.flash("error");
  res.locals.currentPath = req.path;
  res.locals.ngxApplyUrl = ngxApplyUrl();
  res.locals.brand = {
    name: "Trinity Securities Limited",
    portalName: "Offers Portal",
    logo: "/images/tsl-logo.png",
  };
  next();
});

app.use("/", publicRoutes);
app.use("/offers/:offerId/subscribe", subscribeRoutes);
app.use("/admin", adminRoutes);
app.use("/api", apiRoutes);

app.use((req, res) => {
  res.status(404).render("404", { title: "Page not found", layout: "layout" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("500", { title: "Something went wrong", layout: "layout" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trinity Securities Offers Portal running on http://localhost:${PORT}`);
});
