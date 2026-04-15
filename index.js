import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log("REQ", req.method, req.url);
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3001;
const SECRET = process.env.JWT_SECRET || "supersecret";
const INTERNAL_RESET_SECRET =
  process.env.INTERNAL_RESET_SECRET || "change-me-reset-secret";

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function requireManager(req, res, next) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
  });

  if (!user || user.role !== "manager") {
    return res.status(403).json({ error: "Manager access required" });
  }

  req.currentUser = user;
  next();
}

async function attachCurrentUser(req, res, next) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
  });

  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  req.currentUser = user;
  next();
}

function getDateFilter(range) {
  const now = new Date();

  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { gte: start };
  }

  if (range === "7d") {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    return { gte: start };
  }

  if (range === "30d") {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    return { gte: start };
  }

  return undefined;
}

async function sendExpoPushNotifications(messages) {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    const data = await response.json();
    console.log("EXPO PUSH RESPONSE:", data);
  } catch (error) {
    console.error("PUSH SEND ERROR:", error);
  }
}

app.get("/", (_req, res) => {
  res.send("Kitchen Daily Checks API is running");
});

app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const site = await prisma.site.findFirst({
      orderBy: { id: "asc" },
    });

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        siteId: site?.id ?? null,
      },
      include: {
        site: true,
      },
    });

    const token = jwt.sign({ userId: user.id }, SECRET);

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        siteId: user.siteId,
        siteName: user.site?.name || null,
      },
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
      include: { site: true },
    });

    if (!user || !user.password) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const validPassword = bcrypt.compareSync(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const token = jwt.sign({ userId: user.id }, SECRET);

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        siteId: user.siteId,
        siteName: user.site?.name || null,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/push-token", requireAuth, attachCurrentUser, async (req, res) => {
  try {
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({ error: "pushToken is required" });
    }

    const user = await prisma.user.update({
      where: { id: req.currentUser.id },
      data: { pushToken },
      select: {
        id: true,
        email: true,
        pushToken: true,
      },
    });

    res.json(user);
  } catch (error) {
    console.error("PUSH TOKEN ERROR:", error);
    res.status(500).json({ error: "Could not save push token" });
  }
});

app.get("/tasks", requireAuth, attachCurrentUser, async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: {
      assignedUserId: req.currentUser.id,
      siteId: req.currentUser.siteId,
    },
    orderBy: { id: "asc" },
  });

  res.json(tasks);
});

app.post("/tasks/:id/complete", requireAuth, attachCurrentUser, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const existingTask = await prisma.task.findFirst({
      where: {
        id,
        assignedUserId: req.currentUser.id,
        siteId: req.currentUser.siteId,
      },
    });

    if (!existingTask) {
      return res.status(404).json({ error: "Task not found" });
    }

    const task = await prisma.task.update({
      where: { id },
      data: {
        completed: true,
        completedAt: new Date(),
      },
    });

    res.json(task);
  } catch (error) {
    console.error("COMPLETE TASK ERROR:", error);
    res.status(404).json({ error: "Task not found" });
  }
});

app.get("/temperatures", requireAuth, attachCurrentUser, async (req, res) => {
  const logs = await prisma.temperatureLog.findMany({
    where: {
      siteId: req.currentUser.siteId,
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(logs);
});

app.post("/temperatures", requireAuth, attachCurrentUser, async (req, res) => {
  const { fridge, value, type } = req.body;

  if (!fridge || value === undefined || !type) {
    return res.status(400).json({ error: "fridge, value and type are required" });
  }

  const temp = Number(value);
  let status = "green";

  if (type === "fridge") {
    if (temp < 0 || temp > 8) status = "red";
    else if (temp < 2 || temp > 5) status = "amber";
  }

  if (type === "freezer") {
    if (temp > -18) status = "red";
    else if (temp < -21) status = "amber";
  }

  const entry = await prisma.temperatureLog.create({
    data: {
      fridge,
      value: temp,
      type,
      status,
      siteId: req.currentUser.siteId,
    },
  });

  if (status === "red") {
    const managers = await prisma.user.findMany({
      where: {
        role: "manager",
        siteId: req.currentUser.siteId,
        pushToken: { not: null },
      },
      select: {
        pushToken: true,
      },
    });

    const messages = managers
      .filter((m) => m.pushToken)
      .map((m) => ({
        to: m.pushToken,
        sound: "default",
        title: "Red temperature alert",
        body: `${fridge} (${type}) logged ${temp}°C`,
        data: {
          screen: "manager",
          fridge,
          type,
          value: temp,
          status,
        },
      }));

    if (messages.length > 0) {
      await sendExpoPushNotifications(messages);
    }
  }

  res.json(entry);
});

app.get("/manager/users", requireAuth, requireManager, async (req, res) => {
  const users = await prisma.user.findMany({
    where: {
      siteId: req.currentUser.siteId,
    },
    select: {
      id: true,
      email: true,
      role: true,
      siteId: true,
      site: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { id: "asc" },
  });

  res.json(users);
});

app.get("/manager/sites", requireAuth, requireManager, async (_req, res) => {
  const sites = await prisma.site.findMany({
    orderBy: { id: "asc" },
  });

  res.json(sites);
});

app.post("/manager/sites", requireAuth, requireManager, async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Site name is required" });
  }

  try {
    const site = await prisma.site.create({
      data: { name },
    });

    res.json(site);
  } catch (error) {
    console.error("CREATE SITE ERROR:", error);
    res.status(400).json({ error: "Could not create site" });
  }
});

app.post("/manager/sites/:id/reset-settings", requireAuth, requireManager, async (req, res) => {
  const siteId = Number(req.params.id);
  const { resetHour, resetMinute, resetEnabled } = req.body;

  try {
    const site = await prisma.site.update({
      where: { id: siteId },
      data: {
        resetHour: Number(resetHour),
        resetMinute: Number(resetMinute),
        resetEnabled: Boolean(resetEnabled),
      },
    });

    res.json(site);
  } catch (error) {
    console.error("UPDATE SITE RESET SETTINGS ERROR:", error);
    res.status(400).json({ error: "Could not update site reset settings" });
  }
});

app.get("/manager/reset-logs", requireAuth, requireManager, async (req, res) => {
  const logs = await prisma.resetLog.findMany({
    where: {
      siteId: req.currentUser.siteId,
    },
    include: {
      site: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { ranAt: "desc" },
    take: 50,
  });

  res.json(logs);
});

app.post("/manager/users/:id/site", requireAuth, requireManager, async (req, res) => {
  const userId = Number(req.params.id);
  const { siteId } = req.body;

  if (!siteId) {
    return res.status(400).json({ error: "siteId is required" });
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { siteId: Number(siteId) },
      include: {
        site: true,
      },
    });

    res.json(user);
  } catch (error) {
    console.error("ASSIGN USER SITE ERROR:", error);
    res.status(400).json({ error: "Could not assign user to site" });
  }
});

app.post("/manager/users/:id/role", requireAuth, requireManager, async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body;

  if (!role || !["staff", "manager"].includes(role)) {
    return res.status(400).json({ error: "Valid role is required" });
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { role },
      include: {
        site: true,
      },
    });

    res.json(user);
  } catch (error) {
    console.error("UPDATE USER ROLE ERROR:", error);
    res.status(400).json({ error: "Could not update user role" });
  }
});

app.get("/manager/alerts", requireAuth, requireManager, async (req, res) => {
  const alerts = await prisma.temperatureLog.findMany({
    where: {
      siteId: req.currentUser.siteId,
      status: {
        not: "green",
      },
      acknowledged: false,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(alerts);
});

app.get("/manager/alerts/history", requireAuth, requireManager, async (req, res) => {
  const alerts = await prisma.temperatureLog.findMany({
    where: {
      siteId: req.currentUser.siteId,
      status: {
        not: "green",
      },
      acknowledged: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(alerts);
});

app.get("/manager/reports/temperatures", requireAuth, requireManager, async (req, res) => {
  const range = req.query.range;
  const createdAt = getDateFilter(range);

  const logs = await prisma.temperatureLog.findMany({
    where: {
      siteId: req.currentUser.siteId,
      ...(createdAt ? { createdAt } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(logs);
});

app.get("/manager/reports/tasks", requireAuth, requireManager, async (req, res) => {
  const range = req.query.range;
  const completedAt = getDateFilter(range);

  const tasks = await prisma.task.findMany({
    where: {
      siteId: req.currentUser.siteId,
      completedAt: completedAt ? completedAt : { not: null },
    },
    include: {
      assignedUser: {
        select: {
          email: true,
        },
      },
    },
    orderBy: { completedAt: "desc" },
    take: 100,
  });

  res.json(tasks);
});

app.post("/manager/alerts/:id/acknowledge", requireAuth, requireManager, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const existing = await prisma.temperatureLog.findFirst({
      where: {
        id,
        siteId: req.currentUser.siteId,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Alert not found" });
    }

    const alert = await prisma.temperatureLog.update({
      where: { id },
      data: {
        acknowledged: true,
      },
    });

    res.json(alert);
  } catch (error) {
    console.error("ACKNOWLEDGE ALERT ERROR:", error);
    res.status(404).json({ error: "Alert not found" });
  }
});

app.post("/manager/tasks", requireAuth, requireManager, async (req, res) => {
  const { name, assignedUserId } = req.body;

  if (!name || !assignedUserId) {
    return res.status(400).json({ error: "name and assignedUserId are required" });
  }

  const task = await prisma.task.create({
    data: {
      name,
      assignedUserId: Number(assignedUserId),
      siteId: req.currentUser.siteId,
    },
  });

  res.json(task);
});

app.post("/manager/tasks/reset", requireAuth, requireManager, async (req, res) => {
  await prisma.task.updateMany({
    where: {
      siteId: req.currentUser.siteId,
    },
    data: {
      completed: false,
      completedAt: null,
    },
  });

  res.json({ success: true });
});

app.post("/internal/reset-daily-tasks", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== `Bearer ${INTERNAL_RESET_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const sites = await prisma.site.findMany({
      where: {
        resetEnabled: true,
        resetHour: currentHour,
        resetMinute: currentMinute,
      },
      orderBy: { id: "asc" },
    });

    const results = [];

    for (const site of sites) {
      const resetResult = await prisma.task.updateMany({
        where: {
          siteId: site.id,
        },
        data: {
          completed: false,
          completedAt: null,
        },
      });

      await prisma.resetLog.create({
        data: {
          siteId: site.id,
          resetCount: resetResult.count,
        },
      });

      results.push({
        siteId: site.id,
        siteName: site.name,
        resetCount: resetResult.count,
      });
    }

    res.json({
      success: true,
      ranAt: now.toISOString(),
      siteCount: results.length,
      results,
    });
  } catch (error) {
    console.error("INTERNAL RESET ERROR:", error);
    res.status(500).json({ error: "Automatic reset failed" });
  }
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 API running on http://${HOST}:${PORT}`);
});
