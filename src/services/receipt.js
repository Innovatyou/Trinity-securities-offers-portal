/**
 * Payment receipt (see src/routes/admin.js)
 * -----------------------------------------------------------------------
 * Built entirely from data already on the subscription/subscriber/offer
 * records - nothing here is typed in by staff. Only meaningful once a
 * subscription is CONFIRMED (see the route guards).
 * -----------------------------------------------------------------------
 */

const PDFDocument = require("pdfkit");

const RULE_COLOR = "#e5e7eb";
const HEADING_COLOR = "#0f2a52";
const LABEL_COLOR = "#64748b";
const PAGE_RIGHT_EDGE = 545;

function bankDetails() {
  return {
    bankName: process.env.BANK_NAME || "Zenith Bank",
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || "1130098750",
    accountName: process.env.BANK_ACCOUNT_NAME || "TRINITY SECURITIES LIMITED - CLIENT ACCOUNT",
  };
}

function formatMoney(amount, currency) {
  return `${currency}${Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function formatDate(date) {
  return date
    ? new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "-";
}

/**
 * @param {object} subscription - a subscription from db.js, with offer/subscriber/minor attached
 * @returns {object} plain data for renderReceiptPdf()/renderReceiptHtml()
 */
function buildReceiptData(subscription) {
  const offer = subscription.offer;
  const subscriber = subscription.subscriber;
  return {
    receiptNo: subscription.reference,
    issuedAt: new Date(),
    investorName: subscriber ? subscriber.fullName : "-",
    investorEmail: subscriber ? subscriber.email : null,
    investorPhone: subscriber ? subscriber.phone : null,
    onBehalfOf: subscription.isForMinor && subscription.minor ? subscription.minor.fullName : null,
    offerName: offer.name,
    issuer: offer.issuer,
    numberOfShares: subscription.numberOfShares,
    pricePerShare: offer.pricePerShare,
    currency: offer.currency,
    amount: subscription.amount,
    paymentMethod: subscription.paymentMethod === "BANK_TRANSFER" ? "Bank Transfer" : subscription.paymentMethod,
    bank: bankDetails(),
    confirmedAt: subscription.confirmedAt,
    confirmedBy: subscription.confirmedBy,
  };
}

function section(doc, title) {
  doc.fontSize(12).fillColor(HEADING_COLOR).text(title);
  doc
    .moveTo(doc.x, doc.y + 2)
    .lineTo(PAGE_RIGHT_EDGE, doc.y + 2)
    .strokeColor(RULE_COLOR)
    .stroke();
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#000");
}

/**
 * @param {object} data - from buildReceiptData()
 * @returns {Promise<Buffer>}
 */
function renderReceiptPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor(HEADING_COLOR).text("Trinity Securities Limited");
    doc.fontSize(10).fillColor(LABEL_COLOR).text("Payment Receipt");
    doc.moveDown(1.2);

    doc.fontSize(10).fillColor("#000");
    doc.text(`Receipt No: ${data.receiptNo}`);
    doc.text(`Date Issued: ${formatDate(data.issuedAt)}`);
    doc.moveDown();

    section(doc, "Investor Details");
    doc.text(`Name: ${data.investorName}`);
    if (data.onBehalfOf) doc.text(`On behalf of (minor): ${data.onBehalfOf}`);
    if (data.investorEmail) doc.text(`Email: ${data.investorEmail}`);
    if (data.investorPhone) doc.text(`Phone: ${data.investorPhone}`);
    doc.moveDown();

    section(doc, "Subscription Details");
    doc.text(`Offer: ${data.offerName} (${data.issuer})`);
    doc.text(`Number of Shares: ${Number(data.numberOfShares || 0).toLocaleString()}`);
    doc.text(`Price per Share: ${formatMoney(data.pricePerShare, data.currency)}`);
    doc.text(`Total Amount Paid: ${formatMoney(data.amount, data.currency)}`);
    doc.text(`Payment Method: ${data.paymentMethod}`);
    doc.text(`Paid Into: ${data.bank.bankName} - ${data.bank.accountNumber} (${data.bank.accountName})`);
    doc.moveDown();

    section(doc, "Confirmation");
    doc.text("Status: CONFIRMED");
    doc.text(`Confirmed On: ${formatDate(data.confirmedAt)}`);
    if (data.confirmedBy) doc.text(`Confirmed By: ${data.confirmedBy}`);
    doc.moveDown(2);

    doc
      .fontSize(9)
      .fillColor(LABEL_COLOR)
      .text(
        "This receipt confirms Trinity Securities Limited has received and confirmed payment for the " +
          "subscription described above. Please retain this document for your records.",
        { width: 495 }
      );

    doc.end();
  });
}

/**
 * HTML used as the body of the "Email Receipt" message - a readable receipt
 * on its own even for providers that can't carry a PDF attachment.
 * @param {object} data - from buildReceiptData()
 */
function renderReceiptHtml(data) {
  const rows = [
    ["Receipt No", data.receiptNo],
    ["Date Issued", formatDate(data.issuedAt)],
    ["Investor", data.investorName],
    ...(data.onBehalfOf ? [["On behalf of (minor)", data.onBehalfOf]] : []),
    ["Offer", `${data.offerName} (${data.issuer})`],
    ["Number of Shares", Number(data.numberOfShares || 0).toLocaleString()],
    ["Price per Share", formatMoney(data.pricePerShare, data.currency)],
    ["Total Amount Paid", formatMoney(data.amount, data.currency)],
    ["Payment Method", data.paymentMethod],
    ["Paid Into", `${data.bank.bankName} - ${data.bank.accountNumber} (${data.bank.accountName})`],
    ["Status", "CONFIRMED"],
    ["Confirmed On", formatDate(data.confirmedAt)],
  ];
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px;color:#64748b;">${label}</td>` +
        `<td style="padding:6px 12px;font-weight:600;">${value}</td></tr>`
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;">
      <h2 style="color:${HEADING_COLOR};margin-bottom:0;">Trinity Securities Limited</h2>
      <p style="color:${LABEL_COLOR};margin-top:2px;">Payment Receipt</p>
      <table style="border-collapse:collapse;width:100%;margin-top:12px;">${rowsHtml}</table>
      <p style="color:${LABEL_COLOR};font-size:12px;margin-top:16px;">
        This receipt confirms Trinity Securities Limited has received and confirmed payment for the subscription
        described above. Please retain this email for your records.
      </p>
    </div>`;
}

module.exports = { buildReceiptData, renderReceiptPdf, renderReceiptHtml };
