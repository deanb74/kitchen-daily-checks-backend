const INTERNAL_REPORT_SECRET = process.env.INTERNAL_REPORT_SECRET;
const RAILWAY_PRIVATE_DOMAIN = process.env.RAILWAY_PRIVATE_DOMAIN;

const BASE_URL = RAILWAY_PRIVATE_DOMAIN
  ? `http://${RAILWAY_PRIVATE_DOMAIN}:3001`
  : "http://kitchen-daily-checks-backend.railway.internal:3001";

const REPORT_URL = `${BASE_URL}/internal/email-daily-report`;

if (!INTERNAL_REPORT_SECRET) {
  console.error("Missing INTERNAL_REPORT_SECRET");
  process.exit(1);
}

async function run() {
  try {
    const response = await fetch(REPORT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_REPORT_SECRET}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Report failed:", response.status, data);
      process.exit(1);
    }

    console.log("Email report sent:", data);
    process.exit(0);
  } catch (error) {
    console.error("Cron request error:", error);
    process.exit(1);
  }
}

run();
