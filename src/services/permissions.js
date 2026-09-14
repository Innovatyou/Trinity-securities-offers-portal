/**
 * Fixed role -> permission map for the admin dashboard.
 * Roles are defined here rather than in the database - adding a new role
 * is a code change, which is the right amount of ceremony for something
 * that controls who can confirm payments or create other admins.
 */

const ROLES = {
  SUPER_ADMIN: {
    label: "Super Admin",
    permissions: ["manage_offers", "manage_subscriptions", "manage_admins"],
  },
  OFFERS_MANAGER: {
    label: "Offers Manager",
    permissions: ["manage_offers"],
  },
  SUBSCRIPTIONS_REVIEWER: {
    label: "Subscriptions Reviewer",
    permissions: ["manage_subscriptions"],
  },
  FINANCE: {
    label: "Finance",
    permissions: ["manage_subscriptions"],
  },
};

function hasPermission(role, permission) {
  const def = ROLES[role];
  return Boolean(def && def.permissions.includes(permission));
}

function roleLabel(role) {
  return (ROLES[role] && ROLES[role].label) || role;
}

function roleOptions() {
  return Object.entries(ROLES).map(([value, def]) => ({ value, label: def.label }));
}

module.exports = { ROLES, hasPermission, roleLabel, roleOptions };
