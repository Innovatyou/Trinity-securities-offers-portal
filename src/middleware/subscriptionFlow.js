const db = require("../db");

/**
 * Loads the in-progress subscription (created at the Security step) for
 * every /offers/:offerId/subscribe/* route, and guards later steps from
 * being reached before earlier ones are complete.
 */
function loadSubscription(minStatusIndex, statusOrder) {
  return function (req, res, next) {
    const subscriptionId = req.session.subscriptionId;
    if (!subscriptionId) {
      req.flash("error", "Please start your subscription from the beginning.");
      return res.redirect(`/offers/${req.params.offerId}`);
    }

    const subscription = db.getSubscriptionById(subscriptionId);

    if (!subscription || subscription.offerId !== req.params.offerId) {
      req.flash("error", "We couldn't find that subscription. Please start again.");
      return res.redirect(`/offers/${req.params.offerId}`);
    }

    const currentIndex = statusOrder.indexOf(subscription.status);
    if (currentIndex < minStatusIndex) {
      req.flash("error", "Please complete the previous step first.");
      return res.redirect(`/offers/${req.params.offerId}/subscribe`);
    }

    req.subscription = subscription;
    next();
  };
}

module.exports = { loadSubscription };
