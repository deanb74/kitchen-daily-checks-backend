import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import { Resend } from "resend";

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
const INTERNAL_REPORT_SECRET =
  process.env.INTERNAL_REPORT_SECRET || "change-me-report-secret";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const REPORT_FROM = process.env.REPORT_FROM || "";
const REPORT_TO = process.env.REPORT_TO || "";
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

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

    if (existingTask.completed) {
      return res.json({
        success: true,
        alreadyCompleted: true,
        task: existingTask,
      });
    }

    const task = await prisma.task.update({
      where: { id },
      data: {
        completed: true,
        completedAt: new Date(),
      },
    });

    res.json({
      success: true,
      alreadyCompleted: false,
      task,
    });
  } catch (error) {
    console.error("COMPLETE TASK ERROR:", error);
    res.status(500).json({ error: "Could not complete task" });
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
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  const existingRecentLog = await prisma.temperatureLog.findFirst({
    where: {
      siteId: req.currentUser.siteId,
      fridge,
      type,
      value: temp,
      createdAt: {
        gte: fiveMinutesAgo,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingRecentLog) {
    return res.json({
      success: true,
      duplicate: true,
      entry: existingRecentLog,
    });
  }

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

app.get("/staff/dashboard", requireAuth, attachCurrentUser, async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const siteId = req.currentUser.siteId;
  const userId = req.currentUser.id;

  const [site, allTasks, completedToday, latestTemps] = await Promise.all([
    prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        name: true,
        resetHour: true,
        resetMinute: true,
        resetEnabled: true,
      },
    }),

    prisma.task.findMany({
      where: {
        siteId,
        assignedUserId: userId,
      },
      orderBy: { id: "asc" },
    }),

    prisma.task.count({
      where: {
        siteId,
        assignedUserId: userId,
        completedAt: {
          gte: todayStart,
        },
      },
    }),

    prisma.temperatureLog.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const remainingTasks = allTasks.filter((task) => !task.completed).length;

  res.json({
    site,
    tasks: allTasks,
    completedToday,
    remainingTasks,
    latestTemps,
    generatedAt: now.toISOString(),
  });
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
    select: {
      id: true,
      name: true,
      resetHour: true,
      resetMinute: true,
      resetEnabled: true,
      reportEmail: true,
      reportHour: true,
      reportMinute: true,
      reportEnabled: true,
    },
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

app.get("/manager/dashboard", requireAuth, requireManager, async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const siteId = req.currentUser.siteId;

  const [activeAlerts, completedToday, incompleteTasks, latestTemps, site] =
    await Promise.all([
      prisma.temperatureLog.count({
        where: {
          siteId,
          status: { not: "green" },
          acknowledged: false,
        },
      }),

      prisma.task.count({
        where: {
          siteId,
          completedAt: {
            gte: todayStart,
          },
        },
      }),

      prisma.task.count({
        where: {
          siteId,
          completed: false,
        },
      }),

      prisma.temperatureLog.findMany({
        where: { siteId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),

      prisma.site.findUnique({
        where: { id: siteId },
        select: {
          id: true,
          name: true,
          resetHour: true,
          resetMinute: true,
          resetEnabled: true,
        },
      }),
    ]);

  res.json({
    site,
    activeAlerts,
    completedToday,
    incompleteTasks,
    latestTemps,
    generatedAt: now.toISOString(),
  });
});

app.get("/manager/analytics", requireAuth, requireManager, async (req, res) => {
  const range = req.query.range;
  const dateFilter = getDateFilter(range);
  const siteId = req.currentUser.siteId;

  const tempWhere = {
    siteId,
    ...(dateFilter ? { createdAt: dateFilter } : {}),
  };

  const taskWhere = {
    siteId,
    ...(dateFilter ? { completedAt: dateFilter } : {}),
  };

  const [amberAlerts, redAlerts, completedTasks, incompleteTasks, latestResetLog, problemUnits] =
    await Promise.all([
      prisma.temperatureLog.count({
        where: {
          ...tempWhere,
          status: "amber",
        },
      }),

      prisma.temperatureLog.count({
        where: {
          ...tempWhere,
          status: "red",
        },
      }),

      prisma.task.count({
        where: {
          ...taskWhere,
          completedAt: {
            ...(dateFilter || {}),
            not: null,
          },
        },
      }),

      prisma.task.count({
        where: {
          siteId,
          completed: false,
        },
      }),

      prisma.resetLog.findFirst({
        where: { siteId },
        orderBy: { ranAt: "desc" },
      }),

      prisma.temperatureLog.groupBy({
        by: ["fridge"],
        where: {
          ...tempWhere,
          status: {
            in: ["amber", "red"],
          },
        },
        _count: {
          fridge: true,
        },
        orderBy: {
          _count: {
            fridge: "desc",
          },
        },
        take: 5,
      }),
    ]);

  res.json({
    activeAlerts: amberAlerts + redAlerts,
    amberAlerts,
    redAlerts,
    completedTasks,
    incompleteTasks,
    latestResetLog,
    problemUnits,
    range: range || "all",
    generatedAt: new Date().toISOString(),
  });
});

app.get("/manager/analytics/trends", requireAuth, requireManager, async (req, res) => {
  const range = req.query.range;
  const dateFilter = getDateFilter(range);
  const siteId = req.currentUser.siteId;

  const tempWhere = {
    siteId,
    ...(dateFilter ? { createdAt: dateFilter } : {}),
  };

  const taskWhere = {
    siteId,
    ...(dateFilter ? { completedAt: dateFilter } : {}),
  };

  const resetWhere = {
    siteId,
    ...(dateFilter ? { ranAt: dateFilter } : {}),
  };

  const [temperatureLogs, completedTasks, resetLogs] = await Promise.all([
    prisma.temperatureLog.findMany({
      where: tempWhere,
      select: {
        createdAt: true,
        status: true,
      },
      orderBy: { createdAt: "asc" },
    }),

    prisma.task.findMany({
      where: {
        ...taskWhere,
        completedAt: {
          ...(dateFilter || {}),
          not: null,
        },
      },
      select: {
        completedAt: true,
      },
      orderBy: { completedAt: "asc" },
    }),

    prisma.resetLog.findMany({
      where: resetWhere,
      select: {
        ranAt: true,
      },
      orderBy: { ranAt: "asc" },
    }),
  ]);

  const byDay = (items, dateField, filterFn = null) => {
    const grouped = {};

    for (const item of items) {
      if (filterFn && !filterFn(item)) continue;

      const date = new Date(item[dateField]);
      const key = date.toISOString().slice(0, 10);

      grouped[key] = (grouped[key] || 0) + 1;
    }

    return Object.entries(grouped).map(([date, count]) => ({
      date,
      count,
    }));
  };

  const alertTrends = byDay(
    temperatureLogs,
    "createdAt",
    (item) => item.status === "amber" || item.status === "red"
  );

  const completedTaskTrends = byDay(completedTasks, "completedAt");
  const resetTrends = byDay(resetLogs, "ranAt");

  res.json({
    range: range || "all",
    alertTrends,
    completedTaskTrends,
    resetTrends,
    generatedAt: new Date().toISOString(),
  });
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

app.post("/internal/email-daily-report", async (req, res) => {
  const authHeader = req.headers.authorization;
  console.log("=== REPORT AUTH DEBUG START ===");
  console.log("REPORT AUTH HEADER:", authHeader);
  console.log("EXPECTED INTERNAL_REPORT_SECRET:", INTERNAL_REPORT_SECRET);
  console.log("=== REPORT AUTH DEBUG END ===");

  if (!authHeader || authHeader !== `Bearer ${INTERNAL_REPORT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!resend || !REPORT_FROM || !REPORT_TO) {
    return res.status(500).json({ error: "Email service not configured" });
  }

  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const sites = await prisma.site.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        resetHour: true,
        resetMinute: true,
        resetEnabled: true,
      },
    });

    const sections = [];

    for (const site of sites) {
      const [activeAlerts, completedToday, incompleteTasks, latestReset, problemUnits] =
        await Promise.all([
          prisma.temperatureLog.count({
            where: {
              siteId: site.id,
              status: { in: ["amber", "red"] },
              acknowledged: false,
            },
          }),

          prisma.task.count({
            where: {
              siteId: site.id,
              completedAt: { gte: todayStart },
            },
          }),

          prisma.task.count({
            where: {
              siteId: site.id,
              completed: false,
            },
          }),

          prisma.resetLog.findFirst({
            where: { siteId: site.id },
            orderBy: { ranAt: "desc" },
          }),

          prisma.temperatureLog.groupBy({
            by: ["fridge"],
            where: {
              siteId: site.id,
              createdAt: { gte: todayStart },
              status: { in: ["amber", "red"] },
            },
            _count: { fridge: true },
            orderBy: {
              _count: { fridge: "desc" },
            },
            take: 3,
          }),
        ]);

      const problemsHtml =
        problemUnits.length === 0
          ? "<li>No problematic units today</li>"
          : problemUnits
              .map(
                (u) => `<li>${u.fridge}: ${u._count.fridge} alert(s)</li>`
              )
              .join("");

      sections.push(`
        <h2>${site.name}</h2>
        <ul>
          <li>Active alerts: ${activeAlerts}</li>
          <li>Completed tasks today: ${completedToday}</li>
          <li>Incomplete tasks: ${incompleteTasks}</li>
          <li>Next reset: ${
            site.resetEnabled
              ? `${String(site.resetHour).padStart(2, "0")}:${String(site.resetMinute).padStart(2, "0")}`
              : "Disabled"
          }</li>
          <li>Latest reset: ${
            latestReset ? new Date(latestReset.ranAt).toLocaleString() : "None"
          }</li>
        </ul>
        <h3>Most problematic units today</h3>
        <ul>${problemsHtml}</ul>
      `);
    }

    const subject = `Kitchen Daily Checks Report — ${now.toLocaleDateString()}`;

    const html = `
      <div style="font-family: Arial, sans-serif; color: #222;">
        <h1>Kitchen Daily Checks Daily Report</h1>
        <p>Generated: ${now.toLocaleString()}</p>
        ${sections.join("<hr style='margin:24px 0;' />")}
      </div>
    `;

    const { data, error } = await resend.emails.send({
      from: REPORT_FROM,
      to: [REPORT_TO],
      subject,
      html,
    });

    if (error) {
      console.error("RESEND ERROR:", error);
      return res.status(500).json({ error: "Failed to send email", details: error });
    }

    res.json({
      success: true,
      sentAt: now.toISOString(),
      emailId: data?.id || null,
    });
  } catch (error) {
    console.error("EMAIL REPORT ERROR:", error);
    res.status(500).json({ error: "Could not generate email report" });
  }
});

const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 API running on http://${HOST}:${PORT}`);
});
