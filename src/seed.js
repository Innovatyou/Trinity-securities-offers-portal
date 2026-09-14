require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("./db");

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@trinitysecuritiesltd.com").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "ChangeMe123!";

  const existingAdmin = db.findAdminByEmail(adminEmail);
  if (!existingAdmin) {
    db.createAdminUser({
      name: "Trinity Securities Admin",
      email: adminEmail,
      role: "SUPER_ADMIN",
      passwordHash: await bcrypt.hash(adminPassword, 10),
    });
    console.log(`Created admin user: ${adminEmail} / ${adminPassword} (change this password after first login)`);
  } else {
    console.log(`Admin user already exists: ${adminEmail}`);
  }

  const existingOffers = db.listOffers();
  const alreadySeeded = existingOffers.some((o) => o.name === "TRINITY SECURITIES RIGHTS ISSUE");

  if (!alreadySeeded) {
    const closesAt = new Date();
    closesAt.setDate(closesAt.getDate() + 30);

    db.createOffer({
      name: "TRINITY SECURITIES RIGHTS ISSUE",
      issuer: "Trinity Securities Limited",
      summary:
        "Trinity Securities Limited is offering existing and new investors the opportunity to participate in this rights issue. Subscribe below to reserve your shares.",
      pricePerShare: 12.5,
      minimumShares: 100,
      multipleOf: 100,
      maximumShares: 5000000,
      closesAt,
      status: "OPEN",
    });
    console.log("Seeded a demo offer: TRINITY SECURITIES RIGHTS ISSUE");
  } else {
    console.log("Demo offer already exists.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
