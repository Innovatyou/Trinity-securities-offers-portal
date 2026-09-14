const express = require("express");
const { verifyBVN, verifyNIN } = require("../services/verification");

const router = express.Router();

// Small JSON endpoints the Account step calls via fetch() to verify BVN / minor NIN
// inline, the same way the reference screenshots show an inline "Verify" button.
// Results are cached on the session and re-checked when the step is actually
// submitted, so nothing is trusted purely on the client side.

router.post("/verify-bvn", async (req, res) => {
  const { bvn } = req.body;
  const result = await verifyBVN((bvn || "").trim());

  if (result.verified) {
    req.session.verifiedBvn = { value: bvn.trim(), fullName: result.fullName };
  } else {
    req.session.verifiedBvn = null;
  }

  res.json(result);
});

router.post("/verify-nin", async (req, res) => {
  const { nin } = req.body;
  const result = await verifyNIN((nin || "").trim());

  if (result.verified) {
    req.session.verifiedNin = { value: nin.trim(), fullName: result.fullName };
  } else {
    req.session.verifiedNin = null;
  }

  res.json(result);
});

module.exports = router;
