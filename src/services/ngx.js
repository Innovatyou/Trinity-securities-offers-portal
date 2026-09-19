// NGX requires every customer to apply for an offer through its own portal
// (trinity.ngxgroup.org) rather than through this app's in-house Account ->
// Participation flow. This is the one place that knows the URL, so the web
// pages, the /start redirect and the mobile API all agree on it.
//
// Set NGX_APPLY_URL in .env to point somewhere else, or to an empty string to
// switch new applications back to the in-house flow.
const DEFAULT_NGX_APPLY_URL = "https://trinity.ngxgroup.org";

function ngxApplyUrl() {
  const configured = process.env.NGX_APPLY_URL;
  const url = configured === undefined ? DEFAULT_NGX_APPLY_URL : configured.trim();
  return url || null;
}

module.exports = { ngxApplyUrl };
