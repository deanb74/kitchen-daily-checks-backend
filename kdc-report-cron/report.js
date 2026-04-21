const REPORT_URL = process.env.REPORT_URL;
const INTERNAL_REPORT_SECRET = process.env.INTERNAL_REPORT_SECRET;

console.log("🚀 Report cron started");

if (!REPORT_URL) {
  console.error("❌ Missing REPORT_URL");
  process.exit(1);
}

if (!INTERNAL_REPORT_SECRET) {
  console.error("❌ Missing INTERNAL_REPORT_SECRET");
  process.exit(1);
}

async function run() {
  try {
    console.log("📡 Sending request to:", REPORT_URL);

    const response = await fetch(REPORT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_REPORT_SECRET}`,
        "Content-Type": "application/json",
      },
    });

    console.log("📬 Response status:", response.status);

    const data = await response.json().catch(() => ({}));
    console.log("📦 Response data:", data);

    if (!response.ok) {
      console.error("❌ Report send failed");
      process.exit(1);
    }

    console.log("✅ Scheduled email report complete");
    process.exit(0);
  } catch (error) {
    console.error("❌ Cron request error:", error);
    process.exit(1);
  }
}

run();