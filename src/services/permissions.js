/**
 * Roles are fixed in code (adding a brand new role is still a code change -
 * the right amount of ceremony for something that controls who can confirm
 * payments or create other admins), but which permissions each role has is
 * editable at runtime via /admin/roles and persisted in the role_permissions
 * table. DEFAULT_PERMISSIONS below is only the seed used to populate that
 * table the first time the app runs against a fresh database - after that,
 * the database is the source of truth, not this file.
 */

const db = require("../db");

const ROLE_LABELS = {
  SUPER_ADMIN: "Super Admin",
  OFFERS_MANAGER: "Offers Manager",
  CONTENT_MANAGER: "Content Manager",
  MARKETING_MANAGER: "Marketing Manager",
  SUBSCRIPTIONS_REVIEWER: "Subscriptions Reviewer",
  FINANCE: "Finance",
  EXECUTIVE: "Executive",
};

// The full catalog of permissions the app actually checks anywhere
// (routes/admin.js requirePermission(...) calls and can(...) checks in
// views). Shown as the checkbox list on /admin/roles - a permission that
// isn't wired into a route guard yet has no business appearing here.
const PERMISSIONS = [
  { id: "manage_offers", label: "Manage Offers", description: "Create, edit, publish, and delete share offers" },
  {
    id: "manage_subscriptions",
    label: "Manage Subscriptions",
    description: "View, create, and issue receipts for investor subscriptions",
  },
  {
    id: "edit_delete_subscriptions",
    label: "Edit/Delete Subscriptions",
    description: "Alter or permanently remove an existing subscription record",
  },
  { id: "confirm_payment", label: "Confirm Payments", description: "Confirm or reject a reported payment" },
  {
    id: "unconfirm_payment",
    label: "Unconfirm Payments",
    description: "Send a confirmed payment back to the review queue",
  },
  {
    id: "manage_allotment",
    label: "Manage Share Allotment",
    description: "Record how many shares a confirmed subscriber was actually allotted",
  },
  {
    id: "view_executive_dashboard",
    label: "View Executive Dashboard",
    description: "See portal-wide totals and offer performance",
  },
  { id: "manage_news", label: "Manage News & Analysis", description: "Create, edit, and delete news articles" },
  {
    id: "manage_recommendations",
    label: "Manage Stock Recommendations",
    description: "Create, edit, and delete stock recommendations",
  },
  { id: "manage_adverts", label: "Manage Adverts", description: "Create, edit, and delete adverts" },
  { id: "send_adverts", label: "Send Adverts", description: "Push a notification-placement advert to subscribers" },
  { id: "manage_admins", label: "Manage Admin Users", description: "Create, edit, and deactivate admin accounts" },
  {
    id: "manage_roles",
    label: "Manage Roles & Permissions",
    description: "Change which permissions each role grants",
  },
];

const PERMISSION_IDS = new Set(PERMISSIONS.map((p) => p.id));

// Seed data only - see file header. Super Admin is intentionally absent:
// hasPermission() below hardcodes it to always pass, so it's never stored.
const DEFAULT_PERMISSIONS = {
  OFFERS_MANAGER: ["manage_offers"],
  CONTENT_MANAGER: ["manage_news", "manage_recommendations"],
  MARKETING_MANAGER: ["manage_adverts", "send_adverts"],
  SUBSCRIPTIONS_REVIEWER: ["manage_subscriptions"],
  FINANCE: ["manage_subscriptions", "confirm_payment", "unconfirm_payment"],
  EXECUTIVE: ["view_executive_dashboard", "confirm_payment", "manage_allotment"],
};

db.seedRolePermissionsIfEmpty(DEFAULT_PERMISSIONS);

// Small in-memory cache over the role_permissions table - hasPermission()
// runs on essentially every admin request (several times per page, via
// can() in views), and the table only changes when an admin saves changes
// on /admin/roles, so it's cheap to keep a copy in memory and reload it
// only on write instead of hitting SQLite on every check.
let cache = null;

function loadCache() {
  cache = db.getAllRolePermissions();
}

function invalidateCache() {
  cache = null;
}

function permissionsForRole(role) {
  if (!cache) loadCache();
  return cache[role] || [];
}

function hasPermission(role, permission) {
  if (role === "SUPER_ADMIN") return true;
  return permissionsForRole(role).includes(permission);
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

function roleOptions() {
  return Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
}

// For the /admin/roles screen: every editable role (Super Admin excluded -
// it isn't stored and can't be edited) paired with its current permissions.
function getRolePermissionsMap() {
  if (!cache) loadCache();
  const map = {};
  for (const role of Object.keys(ROLE_LABELS)) {
    if (role === "SUPER_ADMIN") continue;
    map[role] = cache[role] || [];
  }
  return map;
}

function updateRolePermissions(role, permissions) {
  if (role === "SUPER_ADMIN" || !ROLE_LABELS[role]) {
    throw new Error(`Cannot set permissions for unknown/protected role: ${role}`);
  }
  const valid = permissions.filter((p) => PERMISSION_IDS.has(p));
  db.setRolePermissions(role, valid);
  invalidateCache();
}

module.exports = {
  PERMISSIONS,
  hasPermission,
  roleLabel,
  roleOptions,
  getRolePermissionsMap,
  updateRolePermissions,
};
