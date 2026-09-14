const { nanoid } = require("nanoid");

/**
 * Generates a human-friendly reference code subscribers must quote as the
 * bank transfer narration, so back office can reconcile a static/shared
 * collection account against many subscriptions.
 *
 * Example: TSL-7X2K9QAB
 */
function generateSubscriptionReference() {
  return `TSL-${nanoid(8).toUpperCase()}`;
}

module.exports = { generateSubscriptionReference };
