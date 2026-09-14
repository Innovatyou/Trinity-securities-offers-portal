/**
 * Data access layer.
 * -----------------------------------------------------------------------
 * Uses better-sqlite3 directly (a small, synchronous, embedded SQLite
 * driver with no native-binary download step) rather than an ORM, so the
 * whole app runs with zero external services - just `npm install && npm
 * run seed && npm start`.
 *
 * To move to Postgres/MySQL in production, this is the only file that
 * needs replacing - every route calls the functions exported here, never
 * raw SQL directly.
 * -----------------------------------------------------------------------
 */

const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_FILE = process.env.DATABASE_FILE || path.join(__dirname, "..", "dev.db");
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    summary TEXT,
    logo_url TEXT,
    price_per_share REAL NOT NULL,
    minimum_shares INTEGER NOT NULL,
    multiple_of INTEGER NOT NULL,
    maximum_shares INTEGER,
    currency TEXT NOT NULL DEFAULT 'NGN',
    opens_at TEXT,
    closes_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    prospectus_url TEXT,
    term_sheet_url TEXT,
    pricing_supplement_url TEXT,
    referral_required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    id TEXT PRIMARY KEY,
    full_name TEXT,
    bvn TEXT UNIQUE NOT NULL,
    bvn_verified INTEGER NOT NULL DEFAULT 0,
    email TEXT,
    phone TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS minor_beneficiaries (
    id TEXT PRIMARY KEY,
    full_name TEXT,
    nin TEXT NOT NULL,
    nin_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    reference TEXT UNIQUE NOT NULL,
    offer_id TEXT NOT NULL REFERENCES offers(id),
    subscriber_id TEXT REFERENCES subscribers(id),
    is_for_minor INTEGER NOT NULL DEFAULT 0,
    minor_id TEXT REFERENCES minor_beneficiaries(id),
    number_of_shares INTEGER,
    amount REAL,
    referral_code TEXT,
    payment_method TEXT,
    status TEXT NOT NULL DEFAULT 'STARTED',
    consent_accepted_at TEXT,
    transfer_reported_at TEXT,
    confirmed_at TEXT,
    confirmed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Migrate admin_users for databases created before role/status existed
// (CREATE TABLE IF NOT EXISTS above only helps brand-new databases).
const adminUserColumns = db.prepare(`PRAGMA table_info(admin_users)`).all().map((c) => c.name);
if (!adminUserColumns.includes("role")) {
  db.exec(`ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'SUPER_ADMIN'`);
}
if (!adminUserColumns.includes("status")) {
  db.exec(`ALTER TABLE admin_users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
}
if (!adminUserColumns.includes("avatar_url")) {
  db.exec(`ALTER TABLE admin_users ADD COLUMN avatar_url TEXT`);
}

function genId() {
  return crypto.randomUUID();
}
function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------
// Row <-> JS object mappers (keep the shape routes/views already expect)
// ---------------------------------------------------------------------

function rowToOffer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    summary: row.summary,
    logoUrl: row.logo_url,
    pricePerShare: row.price_per_share,
    minimumShares: row.minimum_shares,
    multipleOf: row.multiple_of,
    maximumShares: row.maximum_shares,
    currency: row.currency,
    opensAt: row.opens_at ? new Date(row.opens_at) : null,
    closesAt: new Date(row.closes_at),
    status: row.status,
    prospectusUrl: row.prospectus_url,
    termSheetUrl: row.term_sheet_url,
    pricingSupplementUrl: row.pricing_supplement_url,
    referralRequired: Boolean(row.referral_required),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToSubscriber(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    bvn: row.bvn,
    bvnVerified: Boolean(row.bvn_verified),
    email: row.email,
    phone: row.phone,
    createdAt: new Date(row.created_at),
  };
}

function rowToMinor(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    nin: row.nin,
    ninVerified: Boolean(row.nin_verified),
    createdAt: new Date(row.created_at),
  };
}

function rowToSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    offerId: row.offer_id,
    subscriberId: row.subscriber_id,
    isForMinor: Boolean(row.is_for_minor),
    minorId: row.minor_id,
    numberOfShares: row.number_of_shares,
    amount: row.amount,
    referralCode: row.referral_code,
    paymentMethod: row.payment_method,
    status: row.status,
    consentAcceptedAt: row.consent_accepted_at ? new Date(row.consent_accepted_at) : null,
    transferReportedAt: row.transfer_reported_at ? new Date(row.transfer_reported_at) : null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
    confirmedBy: row.confirmed_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    // populated by attachRelations()
    offer: undefined,
    subscriber: undefined,
    minor: undefined,
  };
}

function attachRelations(subscription) {
  if (!subscription) return subscription;
  subscription.offer = getOfferById(subscription.offerId);
  subscription.subscriber = subscription.subscriberId ? getSubscriberById(subscription.subscriberId) : null;
  subscription.minor = subscription.minorId ? getMinorById(subscription.minorId) : null;
  return subscription;
}

// ---------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------

function listOffers({ statuses } = {}) {
  let rows;
  if (statuses && statuses.length) {
    const placeholders = statuses.map(() => "?").join(",");
    rows = db
      .prepare(`SELECT * FROM offers WHERE status IN (${placeholders}) ORDER BY closes_at ASC`)
      .all(...statuses);
  } else {
    rows = db.prepare(`SELECT * FROM offers ORDER BY created_at DESC`).all();
  }
  return rows.map(rowToOffer);
}

function getOfferById(id) {
  return rowToOffer(db.prepare(`SELECT * FROM offers WHERE id = ?`).get(id));
}

function createOffer(data) {
  const id = genId();
  const ts = now();
  db.prepare(
    `INSERT INTO offers
      (id, name, issuer, summary, logo_url, price_per_share, minimum_shares, multiple_of, maximum_shares,
       currency, opens_at, closes_at, status, prospectus_url, term_sheet_url, pricing_supplement_url,
       referral_required, created_at, updated_at)
     VALUES (@id, @name, @issuer, @summary, @logoUrl, @pricePerShare, @minimumShares, @multipleOf, @maximumShares,
       @currency, @opensAt, @closesAt, @status, @prospectusUrl, @termSheetUrl, @pricingSupplementUrl,
       @referralRequired, @createdAt, @updatedAt)`
  ).run({
    id,
    name: data.name,
    issuer: data.issuer,
    summary: data.summary || null,
    logoUrl: data.logoUrl || null,
    pricePerShare: data.pricePerShare,
    minimumShares: data.minimumShares,
    multipleOf: data.multipleOf,
    maximumShares: data.maximumShares || null,
    currency: data.currency || "NGN",
    opensAt: data.opensAt ? data.opensAt.toISOString() : null,
    closesAt: data.closesAt.toISOString(),
    status: data.status || "DRAFT",
    prospectusUrl: data.prospectusUrl || null,
    termSheetUrl: data.termSheetUrl || null,
    pricingSupplementUrl: data.pricingSupplementUrl || null,
    referralRequired: data.referralRequired ? 1 : 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return getOfferById(id);
}

function updateOffer(id, data) {
  db.prepare(
    `UPDATE offers SET
      name = @name, issuer = @issuer, summary = @summary, price_per_share = @pricePerShare,
      minimum_shares = @minimumShares, multiple_of = @multipleOf, maximum_shares = @maximumShares,
      closes_at = @closesAt, status = @status, prospectus_url = @prospectusUrl,
      term_sheet_url = @termSheetUrl, pricing_supplement_url = @pricingSupplementUrl,
      referral_required = @referralRequired, updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id,
    name: data.name,
    issuer: data.issuer,
    summary: data.summary || null,
    pricePerShare: data.pricePerShare,
    minimumShares: data.minimumShares,
    multipleOf: data.multipleOf,
    maximumShares: data.maximumShares || null,
    closesAt: data.closesAt.toISOString(),
    status: data.status || "DRAFT",
    prospectusUrl: data.prospectusUrl || null,
    termSheetUrl: data.termSheetUrl || null,
    pricingSupplementUrl: data.pricingSupplementUrl || null,
    referralRequired: data.referralRequired ? 1 : 0,
    updatedAt: now(),
  });
  return getOfferById(id);
}

function updateOfferStatus(id, status) {
  db.prepare(`UPDATE offers SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
  return getOfferById(id);
}

// ---------------------------------------------------------------------
// Subscribers / Minor beneficiaries
// ---------------------------------------------------------------------

function getSubscriberById(id) {
  return rowToSubscriber(db.prepare(`SELECT * FROM subscribers WHERE id = ?`).get(id));
}

function getSubscriberByBvn(bvn) {
  return rowToSubscriber(db.prepare(`SELECT * FROM subscribers WHERE bvn = ?`).get(bvn));
}

// email/phone are whatever the subscriber verified with at the Security
// step (see subscribe.js) - optional, and only overwrite an existing value
// when a new one is actually supplied (COALESCE), so a returning subscriber
// verifying with the other channel doesn't blank out the one already on file.
function upsertSubscriberByBvn({ bvn, fullName, email, phone }) {
  const existing = getSubscriberByBvn(bvn);
  if (existing) {
    db.prepare(
      `UPDATE subscribers SET bvn_verified = 1, full_name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?`
    ).run(fullName, email || null, phone || null, existing.id);
    return getSubscriberById(existing.id);
  }
  const id = genId();
  db.prepare(
    `INSERT INTO subscribers (id, full_name, bvn, bvn_verified, email, phone, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(id, fullName, bvn, email || null, phone || null, now());
  return getSubscriberById(id);
}

function getMinorById(id) {
  return rowToMinor(db.prepare(`SELECT * FROM minor_beneficiaries WHERE id = ?`).get(id));
}

function createMinor({ nin, fullName }) {
  const id = genId();
  db.prepare(
    `INSERT INTO minor_beneficiaries (id, full_name, nin, nin_verified, created_at) VALUES (?, ?, ?, 1, ?)`
  ).run(id, fullName, nin, now());
  return getMinorById(id);
}

// ---------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------

function getSubscriptionById(id) {
  const row = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  return attachRelations(rowToSubscription(row));
}

function createSubscription({ offerId, reference, referralCode }) {
  const id = genId();
  const ts = now();
  db.prepare(
    `INSERT INTO subscriptions (id, reference, offer_id, referral_code, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'STARTED', ?, ?)`
  ).run(id, reference, offerId, referralCode || null, ts, ts);
  return getSubscriptionById(id);
}

function updateSubscription(id, data) {
  const current = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!current) return null;

  const merged = {
    subscriber_id: data.subscriberId !== undefined ? data.subscriberId : current.subscriber_id,
    is_for_minor: data.isForMinor !== undefined ? (data.isForMinor ? 1 : 0) : current.is_for_minor,
    minor_id: data.minorId !== undefined ? data.minorId : current.minor_id,
    number_of_shares: data.numberOfShares !== undefined ? data.numberOfShares : current.number_of_shares,
    amount: data.amount !== undefined ? data.amount : current.amount,
    payment_method: data.paymentMethod !== undefined ? data.paymentMethod : current.payment_method,
    status: data.status !== undefined ? data.status : current.status,
    consent_accepted_at:
      data.consentAcceptedAt !== undefined ? data.consentAcceptedAt.toISOString() : current.consent_accepted_at,
    transfer_reported_at:
      data.transferReportedAt !== undefined
        ? data.transferReportedAt.toISOString()
        : current.transfer_reported_at,
    confirmed_at: data.confirmedAt !== undefined ? data.confirmedAt.toISOString() : current.confirmed_at,
    confirmed_by: data.confirmedBy !== undefined ? data.confirmedBy : current.confirmed_by,
    updated_at: now(),
  };

  db.prepare(
    `UPDATE subscriptions SET
      subscriber_id = @subscriber_id, is_for_minor = @is_for_minor, minor_id = @minor_id,
      number_of_shares = @number_of_shares, amount = @amount, payment_method = @payment_method,
      status = @status, consent_accepted_at = @consent_accepted_at, transfer_reported_at = @transfer_reported_at,
      confirmed_at = @confirmed_at, confirmed_by = @confirmed_by, updated_at = @updated_at
     WHERE id = @id`
  ).run({ ...merged, id });

  return getSubscriptionById(id);
}

function listSubscriptions({ status } = {}) {
  const rows = status
    ? db.prepare(`SELECT * FROM subscriptions WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM subscriptions ORDER BY created_at DESC`).all();
  return rows.map(rowToSubscription).map(attachRelations);
}

function countSubscriptionsByStatus() {
  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM subscriptions GROUP BY status`).all();
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// ---------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------

function rowToAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    avatarUrl: row.avatar_url,
    createdAt: new Date(row.created_at),
  };
}

function findAdminByEmail(email) {
  return rowToAdmin(db.prepare(`SELECT * FROM admin_users WHERE email = ?`).get(email));
}

function getAdminById(id) {
  return rowToAdmin(db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(id));
}

function listAdminUsers() {
  return db.prepare(`SELECT * FROM admin_users ORDER BY created_at ASC`).all().map(rowToAdmin);
}

function countActiveAdminsByRole(role) {
  return db
    .prepare(`SELECT COUNT(*) as count FROM admin_users WHERE role = ? AND status = 'ACTIVE'`)
    .get(role).count;
}

function createAdminUser({ name, email, passwordHash, role }) {
  const id = genId();
  db.prepare(
    `INSERT INTO admin_users (id, name, email, password_hash, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`
  ).run(id, name, email, passwordHash, role || "SUPER_ADMIN", now());
  return getAdminById(id);
}

function updateAdminUser(id, { name, role, status }) {
  db.prepare(`UPDATE admin_users SET name = ?, role = ?, status = ? WHERE id = ?`).run(name, role, status, id);
  return getAdminById(id);
}

function updateAdminPassword(id, passwordHash) {
  db.prepare(`UPDATE admin_users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
  return getAdminById(id);
}

function updateAdminProfile(id, { name, email, avatarUrl }) {
  const current = getAdminById(id);
  db.prepare(`UPDATE admin_users SET name = ?, email = ?, avatar_url = ? WHERE id = ?`).run(
    name !== undefined ? name : current.name,
    email !== undefined ? email : current.email,
    avatarUrl !== undefined ? avatarUrl : current.avatarUrl,
    id
  );
  return getAdminById(id);
}

module.exports = {
  raw: db,
  listOffers,
  getOfferById,
  createOffer,
  updateOffer,
  updateOfferStatus,
  getSubscriberById,
  getSubscriberByBvn,
  upsertSubscriberByBvn,
  getMinorById,
  createMinor,
  getSubscriptionById,
  createSubscription,
  updateSubscription,
  listSubscriptions,
  countSubscriptionsByStatus,
  findAdminByEmail,
  getAdminById,
  listAdminUsers,
  countActiveAdminsByRole,
  createAdminUser,
  updateAdminUser,
  updateAdminPassword,
  updateAdminProfile,
};
