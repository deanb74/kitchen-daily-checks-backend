const REPORT_URL = process.env.REPORT_URL;
const INTERNAL_REPORT_SECRET = process.env.INTERNAL_REPORT_SECRET;

if (!REPORT_URL) {
  console.error("Missing REPORT_URL");
  process.exit(1);
}

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
      console.error("Report send failed:", response.status, data);
      process.exit(1);
    }

    console.log("Scheduled email report complete:", data);
    process.exit(0);
  } catch (error) {
    console.error("Cron request error:", error);
    process.exit(1);
  }
}

run();