import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

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

app.get("/", (req, res) => {
  res.send("Kitchen Daily Checks API is running");
});

app.post("/register", async (req, res) => {
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

  res.json({
    token,
    user: { id: user.id, email: user.email },
  });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return res.status(401).json({ error: "Invalid login" });
  }

  const validPassword = bcrypt.compareSync(password, user.password);

  if (!validPassword) {
    return res.status(401).json({ error: "Invalid login" });
  }

  const token = jwt.sign({ userId: user.id }, SECRET);

  res.json({
    token,
    user: { id: user.id, email: user.email },
  });
});

app.get("/tasks", requireAuth, async (req, res) => {
  const tasks = await prisma.task.findMany({
    orderBy: { id: "asc" },
  });
  res.json(tasks);
});

app.post("/tasks/:id/complete", requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const task = await prisma.task.update({
      where: { id },
      data: { completed: true },
    });

    res.json(task);
  } catch {
    res.status(404).json({ error: "Task not found" });
  }
});

app.get("/temperatures", requireAuth, async (req, res) => {
  const logs = await prisma.temperatureLog.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(logs);
});

app.post("/temperatures", requireAuth, async (req, res) => {
  const { fridge, value } = req.body;

  if (!fridge || value === undefined || value === "") {
    return res.status(400).json({ error: "fridge and value are required" });
  }

  const entry = await prisma.temperatureLog.create({
    data: {
      fridge,
      value: Number(value),
    },
  });

  res.json(entry);
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
