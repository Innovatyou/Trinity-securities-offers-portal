// Shared client-side behaviour for the 3-step subscription flow.
// Every block below guards on the element existing, so this one file can be
// safely included on the security / account / participation pages.

document.addEventListener("DOMContentLoaded", function () {
  // ---------- Security step: send / verify OTP ----------
  const sendOtpBtn = document.getElementById("send-otp-btn");
  const otpSection = document.getElementById("otp-section");
  const otpDevHint = document.getElementById("otp-dev-hint");
  const destinationInput = document.getElementById("destination");
  const verifyOtpBtn = document.getElementById("verify-otp-btn");
  const otpInput = document.getElementById("otp-code");
  const securityError = document.getElementById("security-error");

  if (sendOtpBtn) {
    sendOtpBtn.addEventListener("click", async function () {
      const destination = destinationInput.value.trim();
      if (!destination) {
        destinationInput.focus();
        return;
      }
      sendOtpBtn.disabled = true;
      sendOtpBtn.textContent = "Sending...";
      const res = await fetch(`${window.SUBSCRIBE_BASE}/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination }),
      });
      const data = await res.json();
      sendOtpBtn.disabled = false;
      sendOtpBtn.textContent = "Resend code";

      if (!data.ok) {
        securityError.textContent = data.message || "Could not send code.";
        securityError.classList.remove("hidden");
        return;
      }
      securityError.classList.add("hidden");
      otpSection.classList.remove("hidden");
      if (data.devCode && otpDevHint) {
        otpDevHint.textContent = `Development mode - your code is ${data.devCode} (a real deployment would text/email this instead).`;
        otpDevHint.classList.remove("hidden");
      }
    });
  }

  if (verifyOtpBtn) {
    verifyOtpBtn.addEventListener("click", async function () {
      const code = otpInput.value.trim();
      if (!code) {
        otpInput.focus();
        return;
      }
      verifyOtpBtn.disabled = true;
      const res = await fetch(`${window.SUBSCRIBE_BASE}/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      verifyOtpBtn.disabled = false;

      if (!data.ok) {
        securityError.textContent = data.message || "Invalid code.";
        securityError.classList.remove("hidden");
        return;
      }
      window.location.href = data.redirectTo;
    });
  }

  // ---------- Account step: subscriber type toggle ----------
  const forMeCard = document.getElementById("for-me-card");
  const forMinorCard = document.getElementById("for-minor-card");
  const subscriptionForInput = document.getElementById("subscriptionFor");
  const minorPanel = document.getElementById("minor-panel");
  const continueBtn = document.getElementById("account-continue-btn");

  function setSubscriptionFor(value) {
    subscriptionForInput.value = value;
    const isMinor = value === "minor";
    forMeCard.classList.toggle("border-navy-700", !isMinor);
    forMeCard.classList.toggle("bg-navy-50", !isMinor);
    forMinorCard.classList.toggle("border-navy-700", isMinor);
    forMinorCard.classList.toggle("bg-navy-50", isMinor);
    minorPanel.classList.toggle("hidden", !isMinor);
    updateContinueState();
  }

  if (forMeCard && forMinorCard) {
    forMeCard.addEventListener("click", () => setSubscriptionFor("me"));
    forMinorCard.addEventListener("click", () => setSubscriptionFor("minor"));
  }

  // ---------- Account step: BVN verify ----------
  const bvnInput = document.getElementById("bvn");
  const bvnCount = document.getElementById("bvn-count");
  const bvnVerifyBtn = document.getElementById("bvn-verify-btn");
  const bvnVerifiedPanel = document.getElementById("bvn-verified-panel");
  const bvnChangeBtn = document.getElementById("bvn-change-btn");
  const bvnErrorEl = document.getElementById("bvn-error");
  const bvnVerifiedNameEl = document.getElementById("bvn-verified-name");
  let bvnVerified = false;

  function updateContinueState() {
    if (!continueBtn) return;
    const isMinor = subscriptionForInput && subscriptionForInput.value === "minor";
    const ninOk = !isMinor || ninVerifiedState;
    continueBtn.disabled = !(bvnVerified && ninOk);
  }

  if (bvnInput) {
    bvnInput.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 11);
      bvnCount.textContent = `${this.value.length}/11`;
      bvnVerifyBtn.disabled = this.value.length !== 11;
    });
  }

  if (bvnVerifyBtn) {
    bvnVerifyBtn.addEventListener("click", async function () {
      bvnVerifyBtn.disabled = true;
      bvnVerifyBtn.textContent = "Verifying...";
      const res = await fetch("/api/verify-bvn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bvn: bvnInput.value }),
      });
      const data = await res.json();
      bvnVerifyBtn.textContent = "Verify";

      if (!data.verified) {
        bvnErrorEl.textContent = data.message || "BVN could not be verified.";
        bvnErrorEl.classList.remove("hidden");
        bvnVerifyBtn.disabled = false;
        bvnVerified = false;
        updateContinueState();
        return;
      }

      bvnErrorEl.classList.add("hidden");
      bvnVerified = true;
      bvnVerifiedNameEl.textContent = data.fullName;
      bvnInput.readOnly = true;
      bvnInput.classList.add("bg-slate-50");
      bvnVerifyBtn.classList.add("hidden");
      bvnVerifiedPanel.classList.remove("hidden");
      updateContinueState();
    });
  }

  if (bvnChangeBtn) {
    bvnChangeBtn.addEventListener("click", function () {
      bvnVerified = false;
      bvnInput.readOnly = false;
      bvnInput.classList.remove("bg-slate-50");
      bvnInput.value = "";
      bvnCount.textContent = "0/11";
      bvnVerifyBtn.classList.remove("hidden");
      bvnVerifyBtn.disabled = true;
      bvnVerifiedPanel.classList.add("hidden");
      updateContinueState();
      bvnInput.focus();
    });
  }

  // ---------- Account step: minor NIN verify ----------
  const ninInput = document.getElementById("nin");
  const ninVerifyBtn = document.getElementById("nin-verify-btn");
  const ninErrorEl = document.getElementById("nin-error");
  const ninVerifiedPanel = document.getElementById("nin-verified-panel");
  let ninVerifiedState = false;

  if (ninInput) {
    ninInput.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 11);
    });
  }

  if (ninVerifyBtn) {
    ninVerifyBtn.addEventListener("click", async function () {
      const value = ninInput.value.trim();
      if (value.length !== 11) {
        ninErrorEl.textContent = "Minor's NIN must be exactly 11 digits.";
        ninErrorEl.classList.remove("hidden");
        return;
      }
      ninVerifyBtn.disabled = true;
      ninVerifyBtn.textContent = "Verifying...";
      const res = await fetch("/api/verify-nin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nin: value }),
      });
      const data = await res.json();
      ninVerifyBtn.disabled = false;
      ninVerifyBtn.textContent = "Verify";

      if (!data.verified) {
        ninErrorEl.textContent = data.message || "NIN not found. Please check and try again.";
        ninErrorEl.classList.remove("hidden");
        ninVerifiedState = false;
        updateContinueState();
        return;
      }
      ninErrorEl.classList.add("hidden");
      ninVerifiedState = true;
      ninVerifiedPanel.classList.remove("hidden");
      updateContinueState();
    });
  }

  // ---------- Participation step: share quantity buttons ----------
  const sharesInput = document.getElementById("numberOfShares");
  const shareButtons = document.querySelectorAll(".share-preset-btn");
  const amountPreview = document.getElementById("amount-preview");
  const pricePerShare = sharesInput ? parseFloat(sharesInput.dataset.price || "0") : 0;
  const currency = sharesInput ? sharesInput.dataset.currency || "NGN" : "NGN";
  const consentCheckbox = document.getElementById("consent");
  const participationSubmitBtn = document.getElementById("participation-submit-btn");

  function formatAmount(shares) {
    const amount = shares * pricePerShare;
    return `${currency}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function refreshAmountPreview() {
    if (!amountPreview || !sharesInput) return;
    const shares = parseInt(sharesInput.value, 10);
    amountPreview.textContent = Number.isInteger(shares) && shares > 0 ? formatAmount(shares) : "-";
  }

  if (sharesInput) {
    sharesInput.addEventListener("input", refreshAmountPreview);
    refreshAmountPreview();
  }

  shareButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      sharesInput.value = btn.dataset.value;
      refreshAmountPreview();
      shareButtons.forEach((b) => b.classList.remove("ring-2", "ring-navy-600"));
      btn.classList.add("ring-2", "ring-navy-600");
    });
  });

  function updateParticipationSubmit() {
    if (!participationSubmitBtn) return;
    participationSubmitBtn.disabled = !(consentCheckbox && consentCheckbox.checked);
  }
  if (consentCheckbox) {
    consentCheckbox.addEventListener("change", updateParticipationSubmit);
    updateParticipationSubmit();
  }

  // ---------- Copy-to-clipboard helpers (bank details) ----------
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const text = btn.getAttribute("data-copy");
      navigator.clipboard.writeText(text).then(function () {
        const original = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = original), 1500);
      });
    });
  });
});
