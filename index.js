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

  next();
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

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
      },
    });

    const token = jwt.sign({ userId: user.id }, SECRET);

    return res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
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
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/push-token", requireAuth, async (req, res) => {
  try {
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({ error: "pushToken is required" });
    }

    const user = await prisma.user.update({
      where: { id: req.user.userId },
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

app.get("/tasks", requireAuth, async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: {
      assignedUserId: req.user.userId,
    },
    orderBy: { id: "asc" },
  });

  res.json(tasks);
});

app.post("/tasks/:id/complete", requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const existingTask = await prisma.task.findFirst({
      where: {
        id,
        assignedUserId: req.user.userId,
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

app.get("/temperatures", requireAuth, async (_req, res) => {
  const logs = await prisma.temperatureLog.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(logs);
});

app.post("/temperatures", requireAuth, async (req, res) => {
  const { fridge, value, type } = req.body;

  if (!fridge || value === undefined || !type) {
    return res.status(400).json({ error: "fridge, value and type are required" });
  }

  const temp = Number(value);
  let status = "green";

  if (type === "fridge") {
    if (temp < 0 || temp > 8) status = "red";
    else if (temp < 2 || temp > 5) status = "amber";
    else status = "green";
  }

  if (type === "freezer") {
    if (temp > -18) status = "red";
    else if (temp < -21) status = "amber";
    else status = "green";
  }

  const entry = await prisma.temperatureLog.create({
    data: {
      fridge,
      value: temp,
      type,
      status,
    },
  });

  if (status === "red") {
    const managers = await prisma.user.findMany({
      where: {
        role: "manager",
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

app.get("/manager/users", requireAuth, requireManager, async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
    },
    orderBy: { id: "asc" },
  });

  res.json(users);
});

app.get("/manager/alerts", requireAuth, requireManager, async (_req, res) => {
  const alerts = await prisma.temperatureLog.findMany({
    where: {
      status: {
        not: "green",
      },
      acknowledged: false,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(alerts);
});

app.get("/manager/alerts/history", requireAuth, requireManager, async (_req, res) => {
  const alerts = await prisma.temperatureLog.findMany({
    where: {
      status: {
        not: "green",
      },
      acknowledged: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(alerts);
});

app.get("/manager/reports/temperatures", requireAuth, requireManager, async (_req, res) => {
  const logs = await prisma.temperatureLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json(logs);
});

app.get("/manager/reports/tasks", requireAuth, requireManager, async (_req, res) => {
  const tasks = await prisma.task.findMany({
    where: {
      completedAt: {
        not: null,
      },
    },
    include: {
      assignedUser: {
        select: {
          email: true,
        },
      },
    },
    orderBy: { completedAt: "desc" },
    take: 50,
  });

  res.json(tasks);
});

app.post("/manager/alerts/:id/acknowledge", requireAuth, requireManager, async (req, res) => {
  const id = Number(req.params.id);

  try {
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
    },
  });

  res.json(task);
});

app.post("/manager/tasks/reset", requireAuth, requireManager, async (_req, res) => {
  await prisma.task.updateMany({
    data: {
      completed: false,
      completedAt: null,
    },
  });

  res.json({ success: true });
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
