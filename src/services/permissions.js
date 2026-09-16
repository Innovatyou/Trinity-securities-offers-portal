/**
 * Fixed role -> permission map for the admin dashboard.
 * Roles are defined here rather than in the database - adding a new role
 * is a code change, which is the right amount of ceremony for something
 * that controls who can confirm payments or create other admins.
 */

const ROLES = {
  // Listed for documentation even though hasPermission() below always grants
  // Super Admin every permission regardless of this list - that bypass is
  // the actual guarantee ("Super Admin has all rights"), immune to a future
  // permission being added here and forgotten for this role.
  SUPER_ADMIN: {
    label: "Super Admin",
    permissions: [
      "manage_offers",
      "manage_subscriptions",
      "manage_admins",
      "view_executive_dashboard",
      "confirm_payment",
      "unconfirm_payment",
      "edit_delete_subscriptions",
      "manage_news",
      "manage_recommendations",
      "manage_adverts",
      "send_adverts",
      "manage_allotment",
    ],
  },
  OFFERS_MANAGER: {
    label: "Offers Manager",
    permissions: ["manage_offers"],
  },
  CONTENT_MANAGER: {
    label: "Content Manager",
    permissions: ["manage_news", "manage_recommendations"],
  },
  MARKETING_MANAGER: {
    label: "Marketing Manager",
    permissions: ["manage_adverts", "send_adverts"],
  },
  // Can view/create subscriptions and issue receipts, but not confirm/reject
  // (Finance/Executive/Super Admin only) and not edit/delete an existing
  // subscription record (Super Admin only) - separation of duties: neither
  // reviewing/entering data nor confirming payment should come with the
  // power to alter or erase the record afterwards.
  SUBSCRIPTIONS_REVIEWER: {
    label: "Subscriptions Reviewer",
    permissions: ["manage_subscriptions"],
  },
  FINANCE: {
    label: "Finance",
    permissions: ["manage_subscriptions", "confirm_payment", "unconfirm_payment"],
  },
  EXECUTIVE: {
    label: "Executive",
    permissions: ["view_executive_dashboard", "confirm_payment", "manage_allotment"],
  },
};

function hasPermission(role, permission) {
  if (role === "SUPER_ADMIN") return true;
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
