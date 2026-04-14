const RESET_URL = process.env.RESET_URL;
const INTERNAL_RESET_SECRET = process.env.INTERNAL_RESET_SECRET;

if (!RESET_URL) {
  console.error("Missing RESET_URL");
  process.exit(1);
}

if (!INTERNAL_RESET_SECRET) {
  console.error("Missing INTERNAL_RESET_SECRET");
  process.exit(1);
}

async function run() {
  try {
    const response = await fetch(RESET_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_RESET_SECRET}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Reset failed:", response.status, data);
      process.exit(1);
    }

    console.log("Automatic reset complete:", data);
    process.exit(0);
  } catch (error) {
    console.error("Cron request error:", error);
    process.exit(1);
  }
}

run();