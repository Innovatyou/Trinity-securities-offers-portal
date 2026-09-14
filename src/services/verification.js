/**
 * Verification service
 * -----------------------------------------------------------------------
 * This is a thin, pluggable layer around BVN / NIN verification.
 *
 * VERIFICATION_MODE=MOCK (default): accepts any well-formed 11-digit
 * number and returns a placeholder name, so the rest of the app and the
 * UX flow can be built/tested without a live KYC contract.
 *
 * VERIFICATION_MODE=LIVE: routes both checks through Veltrix Verify's
 * partner API (`/api/verify/v1/kyc/identity`), which itself sits in front
 * of NIMC/NIBSS registries. Set VELTRIX_BASE_URL, VELTRIX_VERIFY_KEY_ID
 * and VELTRIX_VERIFY_SECRET (issued at Veltrix > Customer > Verify > API
 * Access, scope "kyc") in .env. Every caller still only ever talks to
 * verifyBVN()/verifyNIN() below.
 * -----------------------------------------------------------------------
 */

const veltrix = require("./veltrixClient");

const MODE = process.env.VERIFICATION_MODE || "MOCK";

function isElevenDigits(value) {
  return typeof value === "string" && /^\d{11}$/.test(value);
}

async function callLiveBVN(bvn) {
  return veltrix.verifyIdentity("bvn", bvn);
}

async function callLiveNIN(nin) {
  return veltrix.verifyIdentity("nin", nin);
}

/**
 * @param {string} bvn - 11-digit Bank Verification Number
 * @returns {Promise<{verified: boolean, fullName?: string, message?: string}>}
 */
async function verifyBVN(bvn) {
  if (!isElevenDigits(bvn)) {
    return { verified: false, message: "BVN must be exactly 11 digits." };
  }

  if (MODE === "LIVE") {
    try {
      return await callLiveBVN(bvn);
    } catch (err) {
      console.error("BVN verification failed:", err.message);
      return { verified: false, message: "We could not verify that BVN right now. Please try again shortly." };
    }
  }

  // MOCK mode: deterministic "success" so the same BVN always verifies the
  // same way during a demo, without ever storing a real identity match.
  return {
    verified: true,
    fullName: "ADISA OPEYEMI",
    message: "Mock verification - replace with a live KYC provider before production use.",
  };
}

/**
 * @param {string} nin - 11-digit National Identification Number (minor)
 * @returns {Promise<{verified: boolean, fullName?: string, message?: string}>}
 */
async function verifyNIN(nin) {
  if (!isElevenDigits(nin)) {
    return { verified: false, message: "NIN must be exactly 11 digits." };
  }

  if (MODE === "LIVE") {
    try {
      return await callLiveNIN(nin);
    } catch (err) {
      console.error("NIN verification failed:", err.message);
      return { verified: false, message: "We could not verify that NIN right now. Please try again shortly." };
    }
  }

  return {
    verified: true,
    fullName: "MINOR BENEFICIARY",
    message: "Mock verification - replace with a live KYC provider before production use.",
  };
}

module.exports = { verifyBVN, verifyNIN, MODE };
