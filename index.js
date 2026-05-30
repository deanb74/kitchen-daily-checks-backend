import { PrismaClient } from "@prisma/client";
// Equipment fault reporting route (after app and middleware setup)
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import PDFDocument from "pdfkit";
import { Resend } from "resend";

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log("REQ", req.method, req.url);
  next();

});

app.get("/manager/suppressed-tasks", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);

    const tasks = await prisma.task.findMany({
      where: {
        siteId,
        equipmentId: { not: null },
      },
      orderBy: { id: "asc" },
    });

    const equipmentIds = [
      ...new Set(tasks.map((task) => task.equipmentId).filter(Boolean)),
    ];

    const outOfServiceEquipment = equipmentIds.length
      ? await prisma.equipment.findMany({
          where: {
            id: { in: equipmentIds },
            outOfService: true,
          },
        })
      : [];

    const equipmentById = new Map(
      outOfServiceEquipment.map((equipment) => [equipment.id, equipment])
    );

    const suppressedTasks = tasks
      .filter((task) => equipmentById.has(task.equipmentId))
      .map((task) => {
        const equipment = equipmentById.get(task.equipmentId);

        return {
          taskId: task.id,
          taskName: task.name,
          department: task.department,
          frequency: task.frequency,
          equipmentId: equipment?.id || null,
          equipmentName: equipment?.name || "Unknown equipment",
          equipmentType: equipment?.type || null,
          reason: "Equipment out of service",
          faultNotes: equipment?.faultNotes || null,
        };
      });

    res.json({
      siteId,
      count: suppressedTasks.length,
      suppressedTasks,
    });
  } catch (err) {
    console.error("SUPPRESSED TASKS ERROR:", err);
    res.status(500).json({ error: "Could not load suppressed tasks" });
  }
});

app.post("/equipment/:id/report-fault", requireAuth, attachCurrentUser, async (req, res) => {
  try {
    const equipment = await prisma.equipment.update({
      where: {
        id: Number(req.params.id),
      },
      data: {
        faultReported: true,
        outOfService: true,
        faultNotes: req.body.notes || null,
      },
    });

    await prisma.complianceRecord.create({
      data: {
        siteId: equipment.siteId,
        userId: req.currentUser.id,
        type: "equipment_fault",
        notes: req.body.notes || "Equipment fault reported",
        verified: false,
      },
    });

    res.json({
      success: true,
      equipment,
    });
  } catch (error) {
    console.error("REPORT EQUIPMENT FAULT ERROR:", error);

    res.status(500).json({
      error: "Could not report equipment fault",
    });
  }
});


app.post("/equipment/:id/return-to-service", requireAuth, attachCurrentUser, async (req, res) => {
  try {
    const equipmentId = Number(req.params.id);

    if (!equipmentId || equipmentId <= 0) {
      return res.status(400).json({ error: "Invalid equipment ID" });
    }

    const equipment = await prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        faultReported: false,
        outOfService: false,
        faultNotes: null,
        lastMaintenanceAt: new Date(),
      },
    });

    await prisma.complianceRecord.create({
      data: {
        siteId: equipment.siteId,
        userId: req.currentUser.id,
        type: "equipment_returned_to_service",
        notes: req.body.notes || `${equipment.name} returned to service`,
        verified: true,
        verifiedById: req.currentUser.id,
        verifiedAt: new Date(),
      },
    });

    res.json({
      success: true,
      message: `${equipment.name} returned to service`,
      equipment,
    });
  } catch (error) {
    console.error("RETURN EQUIPMENT TO SERVICE ERROR:", error);
    res.status(500).json({ error: "Could not return equipment to service" });
  }
});

// ...other routes and middleware...

// Place after app and middleware setup, near other manager routes
app.get("/manager/training-insights", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);

    const records = await prisma.complianceRecord.findMany({
      where: {
        siteId,
        correctiveAction: { not: null },
      },
      include: {
        task: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const byStaff = {};
    const byTask = {};
    const recommendations = [];

    for (const record of records) {
      const staffKey = String(record.userId);
      const taskName = record.task?.name || `Task ${record.taskId}`;

      byStaff[staffKey] = (byStaff[staffKey] || 0) + 1;
      byTask[taskName] = (byTask[taskName] || 0) + 1;
    }

    for (const [userId, count] of Object.entries(byStaff)) {
      if (count >= 2) {
        recommendations.push({
          type: "staff_training",
          severity: count >= 4 ? "high" : "medium",
          title: `User ${userId} may need coaching`,
          message: `This staff member has received ${count} corrective actions.`,
          userId: Number(userId),
        });
      }
    }

    for (const [taskName, count] of Object.entries(byTask)) {
      if (count >= 2) {
        recommendations.push({
          type: "task_sop_review",
          severity: count >= 4 ? "high" : "medium",
          title: `${taskName} may need clearer instructions`,
          message: `This task has generated ${count} corrective actions.`,
          taskName,
        });
      }
    }

    res.json({
      totalCorrectiveActions: records.length,
      recommendationCount: recommendations.length,
      recommendations,
    });
  } catch (error) {
    console.error("TRAINING INSIGHTS ERROR:", error);
    res.status(500).json({ error: "Could not load training insights" });
  }
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

function getManagerSiteId(req) {
  const siteId = req.query.siteId || req.body.siteId || req.currentUser.siteId;
  return Number(siteId);
}

function applyDepartmentScope(req, where = {}) {
  if (
    req.currentUser?.role === "department_manager" &&
    req.currentUser?.department
  ) {
    return {
      ...where,
      department: req.currentUser.department,
    };
  }

  return where;
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
  const department = req.query.department;

  const where = applyDepartmentScope(req, {
    assignedUserId: req.currentUser.id,
    siteId: req.currentUser.siteId,
    ...(department && department !== "all" ? { department } : {}),
  });

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { id: "asc" },
  });

  const equipmentIds = [
    ...new Set(tasks.map((task) => task.equipmentId).filter(Boolean)),
  ];

  const outOfServiceEquipment = equipmentIds.length
    ? await prisma.equipment.findMany({
        where: {
          id: { in: equipmentIds },
          outOfService: true,
        },
        select: { id: true },
      })
    : [];

  const outOfServiceEquipmentIds = new Set(
    outOfServiceEquipment.map((equipment) => equipment.id)
  );

  const visibleTasks = tasks.filter((task) => {
    if (!task.equipmentId) return true;
    return !outOfServiceEquipmentIds.has(task.equipmentId);
  });

  res.json(visibleTasks);
});

app.post("/tasks/:id/complete", requireAuth, attachCurrentUser, async (req, res) => {
  const id = Number(req.params.id);
  const { note, correctionResponse } = req.body;

  try {
    const existingTask = await prisma.task.findFirst({
      where: {
        id,
        assignedUserId: req.currentUser.id,
        siteId: req.currentUser.siteId || null,
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

    const completedTask = await prisma.task.update({
      where: { id: Number(req.params.id) },
      data: {
        completed: true,
        completedAt: new Date(),
        completedById: req.currentUser.id,
        completedByEmail: req.currentUser.email,
      },
    });

    if (note) {
      await prisma.complianceRecord.create({
        data: {
          taskId: Number(req.params.id),
          userId: req.currentUser.id,
          siteId: completedTask.siteId || req.currentUser.siteId || null,
          type: "task_completion_note",
          notes: note,
        },
      });
    }


    // Store correction response as a separate compliance record if provided
    if (correctionResponse) {
      await prisma.complianceRecord.create({
        data: {
          taskId: completedTask.id,
          userId: req.currentUser.id,
          siteId: completedTask.siteId || req.currentUser.siteId || null,
          type: "corrective_resolution_note",
          notes: correctionResponse,
          verified: true,
          verifiedById: req.currentUser.id,
          verifiedAt: new Date(),
        },
      });
    }

    await prisma.complianceRecord.updateMany({
      where: {
        taskId: Number(req.params.id),
        correctiveAction: { not: null },
        verified: false,
      },
      data: {
        verified: true,
        verifiedById: req.currentUser.id,
        verifiedAt: new Date(),
      },
    });

    res.json({
      success: true,
      alreadyCompleted: false,
      task: completedTask,
    });
  } catch (error) {
    console.error("COMPLETE TASK ERROR:", error);
    res.status(500).json({ error: "Could not complete task" });
  }
});

app.post("/shift/start", requireAuth, attachCurrentUser, async (req, res) => {
  try {
    const user = req.currentUser;
    const today = new Date().toISOString().slice(0, 10);

    if (!user.siteId) {
      return res.status(400).json({ error: "User has no site assigned" });
    }

    const shift = await prisma.shift.create({
      data: {
        userId: user.id,
        siteId: user.siteId,
        department: user.department || null,
      },
    });

    const templates = await prisma.taskTemplate.findMany({
      where: {
        autoCreate: true,
        ...(user.department ? { department: user.department } : {}),
      },
      orderBy: { id: "asc" },
    });

    const created = [];
    const skipped = [];


    for (const template of templates) {
      if (!shouldGenerateTemplate(template)) continue;

      // Skip if equipment-linked template and equipment does not exist/active at site
      if (template.equipmentId) {
        const equipment = await prisma.equipment.findFirst({
          where: {
            id: template.equipmentId,
            siteId: user.siteId,
            active: true,
          },
        });
        if (!equipment) continue;
      }

      const existing = await prisma.task.findFirst({
        where: {
          templateId: template.id,
          taskDate: today,
          assignedUserId: user.id,
          siteId: user.siteId,
        },
      });

      if (existing) {
        skipped.push(existing);
        continue;
      }

      const dueAt = buildDueAt(today, template.dueHour, template.dueMinute);

      const task = await prisma.task.create({
        data: {
          name: template.name,
          department: template.department,
          frequency: template.frequency,
          templateId: template.id,
          taskDate: today,
          dueAt,
          assignedUserId: user.id,
          siteId: user.siteId,
        },
      });

      created.push(task);
    }

    res.json({
      success: true,
      taskDate: today,
      shift,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped,
    });
  } catch (error) {
    console.error("SHIFT START ERROR:", error);
    res.status(500).json({ error: "Could not start shift" });
  }
});

app.post("/shift/end", requireAuth, attachCurrentUser, async (req, res) => {
  try {
    const user = req.currentUser;
    const { handoverNotes } = req.body;
    const now = new Date();

    const shift = await prisma.shift.findFirst({
      where: {
        userId: user.id,
        endedAt: null,
      },
      orderBy: { startedAt: "desc" },
    });

    if (!shift) {
      return res.status(404).json({ error: "No open shift found" });
    }

    const openTasks = await prisma.task.findMany({
      where: {
        assignedUserId: user.id,
        siteId: user.siteId,
        completed: false,
      },
      orderBy: [
        { escalationLevel: "desc" },
        { dueAt: "asc" },
        { id: "asc" },
      ],
    });

    const overdueTasks = openTasks.filter(
      (task) => task.dueAt && new Date(task.dueAt) < now
    );

    const escalatedTasks = openTasks.filter(
      (task) => task.escalationLevel > 0
    );

    const updatedShift = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        endedAt: now,
        handoverNotes: handoverNotes || null,
      },
    });

    res.json({
      success: true,
      shift: updatedShift,
      summary: {
        openTaskCount: openTasks.length,
        overdueTaskCount: overdueTasks.length,
        escalatedTaskCount: escalatedTasks.length,
      },
      openTasks,
      overdueTasks,
      escalatedTasks,
    });
  } catch (error) {
    console.error("SHIFT END ERROR:", error);
    res.status(500).json({ error: "Could not end shift" });
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

app.get("/staff/corrective-actions", requireAuth, attachCurrentUser, async (req, res) => {
  try {
    const records = await prisma.complianceRecord.findMany({
      where: {
        siteId: req.currentUser.siteId,
        correctiveAction: { not: null },
        verified: false,
        OR: [
          { userId: req.currentUser.id },
          {
            task: {
              assignedUserId: req.currentUser.id,
            },
          },
        ],
      },
      include: {
        task: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json(records);
  } catch (error) {
    console.error("STAFF CORRECTIVE ACTIONS ERROR:", error);
    res.status(500).json({
      error: "Could not load corrective actions",
      details: error.message,
    });
  }
});

app.get("/manager/users", requireAuth, requireManager, async (req, res) => {
  const users = await prisma.user.findMany({
    include: {
      site: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  res.json(users);
});

app.get("/manager/sites", requireAuth, requireManager, async (_req, res) => {
  const sites = await prisma.site.findMany({
    orderBy: { id: "asc" },
  });

  res.json(sites);
});

app.get("/manager/shifts", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);

  const shifts = await prisma.shift.findMany({
    where: { siteId },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  res.json(shifts);
});


app.get("/manager/compliance-records", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);

  const records = await prisma.complianceRecord.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(records);
});

// Venue setup presets routes
app.get("/manager/venue-presets", requireAuth, requireManager, (_req, res) => {
  res.json(VENUE_SETUP_PRESETS);
});

app.post("/manager/venue-presets/:presetId/import", requireAuth, requireManager, async (req, res) => {
  try {
    const { presetId } = req.params;
    const siteId = getManagerSiteId(req);

    if (!siteId) {
      return res.status(400).json({ error: "Manager is not assigned to a site" });
    }

    const preset = VENUE_SETUP_PRESETS.find((p) => p.id === presetId);

    if (!preset) {
      return res.status(404).json({ error: "Venue preset not found" });
    }

    await prisma.site.update({
      where: { id: siteId },
      data: { venueType: preset.id },
    });

    const createdAreas = [];
    const createdEquipment = [];
    const createdTasks = [];

    for (const area of preset.areas || []) {
      let newArea = await prisma.area.findFirst({
        where: {
          siteId,
          name: area.name,
        },
      });

      if (!newArea) {
        newArea = await prisma.area.create({
          data: {
            siteId,
            name: area.name,
            category: area.category || area.department || "general",
          },
        });

        createdAreas.push(newArea);
      }

      for (const item of area.equipment || []) {
        let equipment = await prisma.equipment.findFirst({
          where: {
            siteId,
            areaId: newArea.id,
            name: item.name,
          },
        });

        if (!equipment) {
          equipment = await prisma.equipment.create({
            data: {
              siteId,
              areaId: newArea.id,
              name: item.name,
              type: item.type || null,
              cleaningIntervalDays: item.cleaningIntervalDays || null,
              maintenanceIntervalDays: item.maintenanceIntervalDays || null,
            },
          });

          createdEquipment.push(equipment);
        }

        if (item.createTask !== false) {
          const taskName = item.taskName || `Check ${item.name}`;

          const existingTask = await prisma.task.findFirst({
            where: {
              siteId,
              areaId: newArea.id,
              equipmentId: equipment.id,
              name: taskName,
            },
          });

          if (!existingTask) {
            const task = await prisma.task.create({
              data: {
                siteId,
                areaId: newArea.id,
                equipmentId: equipment.id,
                name: taskName,
                department: area.department || area.category || "kitchen",
                frequency: item.frequency || "daily",
              },
            });

            createdTasks.push(task);
          }
        }
      }
    }

    for (const task of preset.tasks || []) {
      const existingTask = await prisma.task.findFirst({
        where: {
          siteId,
          name: task.name,
          department: task.department || "kitchen",
          equipmentId: null,
        },
      });

      if (!existingTask) {
        const createdTask = await prisma.task.create({
          data: {
            siteId,
            name: task.name,
            department: task.department || "kitchen",
            frequency: task.frequency || "daily",
          },
        });

        createdTasks.push(createdTask);
      }
    }

    res.json({
      success: true,
      message: `${preset.name} imported successfully`,
      siteId,
      venueType: preset.id,
      created: {
        areas: createdAreas.length,
        equipment: createdEquipment.length,
        tasks: createdTasks.length,
      },
    });
  } catch (err) {
    console.error("Venue preset import failed:", err);
    res.status(500).json({ error: "Venue preset import failed" });
  }
});

app.get("/manager/corrective-dashboard", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);

    const records = await prisma.complianceRecord.findMany({
      where: {
        siteId,
        correctiveAction: { not: null },
      },
      include: {
        task: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const openCount = records.filter((r) => !r.verified).length;
    const resolvedCount = records.filter((r) => r.verified).length;

    // Staff/Task/Department intelligence
    const byTask = {};
    const byStaff = {};
    const byDepartment = {};

    for (const record of records) {
      const taskName = record.task?.name || `Task ${record.taskId}`;
      const staffKey = String(record.userId);
      const department = record.task?.department || "unknown";

      byTask[taskName] = (byTask[taskName] || 0) + 1;
      byStaff[staffKey] = (byStaff[staffKey] || 0) + 1;
      byDepartment[department] = (byDepartment[department] || 0) + 1;
    }

    const topFailingTasks = Object.entries(byTask)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topStaffCorrectiveActions = Object.entries(byStaff)
      .map(([userId, count]) => ({ userId: Number(userId), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topDepartments = Object.entries(byDepartment)
      .map(([department, count]) => ({ department, count }))
      .sort((a, b) => b.count - a.count);

    const repeatFailures = records.reduce((acc, record) => {
      const key = record.task?.name || `Task ${record.taskId}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    res.json({
      openCount,
      resolvedCount,
      total: records.length,
      repeatFailures,
      records,
      topFailingTasks,
      topStaffCorrectiveActions,
      topDepartments,
    });
  } catch (error) {
    console.error("CORRECTIVE DASHBOARD ERROR:", error);

    res.status(500).json({
      error: "Could not load corrective dashboard",
    });
  }
});

app.post("/manager/compliance-records/:id/verify", requireAuth, requireManager, async (req, res) => {
  const record = await prisma.complianceRecord.update({
    where: { id: Number(req.params.id) },
    data: {
      verified: true,
      verifiedById: req.currentUser.id,
      verifiedAt: new Date(),
    },
  });

  res.json(record);
});

app.post("/manager/compliance-records/:id/corrective-action", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);
    const { correctiveAction } = req.body;

    if (!correctiveAction) {
      return res.status(400).json({ error: "Corrective action is required" });
    }

    const existing = await prisma.complianceRecord.findFirst({
      where: {
        id: Number(req.params.id),
        siteId,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Compliance record not found" });
    }

    const record = await prisma.complianceRecord.update({
      where: { id: existing.id },
      data: {
        verified: false,
        correctiveAction,
      },
    });

    await prisma.task.update({
      where: { id: existing.taskId },
      data: {
        completed: false,
        completedAt: null,
        completedById: null,
        completedByEmail: null,
        escalationLevel: {
          increment: 1,
        },
      },
    });

    res.json(record);
  } catch (error) {
    console.error("CORRECTIVE ACTION ERROR:", error);
    res.status(500).json({ error: "Could not request corrective action" });
  }
});

app.get("/manager/areas", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);

    const areas = await prisma.area.findMany({
      where: { siteId },
      orderBy: { id: "asc" },
    });

    res.json(areas);
  } catch (error) {
    console.error("GET AREAS ERROR:", error);
    res.status(500).json({ error: "Could not load areas" });
  }
});

app.post("/manager/areas", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);
    const { name, category } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Area name is required" });
    }

    const area = await prisma.area.create({
      data: {
        siteId,
        name,
        category: category || null,
      },
    });

    res.json(area);
  } catch (error) {
    console.error("CREATE AREA ERROR:", error);
    res.status(400).json({ error: "Could not create area" });
  }
});

app.get("/manager/equipment", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);

    const equipment = await prisma.equipment.findMany({
      where: { siteId },
      include: { area: true },
      orderBy: { id: "asc" },
    });

    res.json(equipment);
  } catch (error) {
    console.error("GET EQUIPMENT ERROR:", error);
    res.status(500).json({ error: "Could not load equipment" });
  }
});

app.post("/manager/equipment", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);
    const { name, type, areaId } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Equipment name is required" });
    }

    const equipment = await prisma.equipment.create({
      data: {
        siteId,
        name,
        type: type || null,
        areaId: areaId ? Number(areaId) : null,
      },
      include: { area: true },
    });

    res.json(equipment);
  } catch (error) {
    console.error("CREATE EQUIPMENT ERROR:", error);
    res.status(400).json({ error: "Could not create equipment" });
  }
});

app.post("/manager/equipment/:id/area", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  const { areaId } = req.body;

  const equipment = await prisma.equipment.updateMany({
    where: {
      id: Number(req.params.id),
      siteId,
    },
    data: {
      areaId: areaId ? Number(areaId) : null,
    },
  });

  res.json({ success: true, equipment });
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
  const siteId = getManagerSiteId(req);
  const logs = await prisma.resetLog.findMany({
    where: {
      siteId,
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

  const siteId = getManagerSiteId(req);

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
  const siteId = getManagerSiteId(req);

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
  const siteId = getManagerSiteId(req);

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

app.post("/manager/users/:id/department", requireAuth, requireManager, async (req, res) => {
  const userId = Number(req.params.id);
  const { department } = req.body;

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { department },
      include: { site: true },
    });

    res.json(user);
  } catch (error) {
    console.error("UPDATE USER DEPARTMENT ERROR:", error);
    res.status(400).json({ error: "Could not update user department" });
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
  const siteId = getManagerSiteId(req);
  const alerts = await prisma.temperatureLog.findMany({
    where: {
      siteId,
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
  const siteId = getManagerSiteId(req);
  const alerts = await prisma.temperatureLog.findMany({
    where: {
      siteId,
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
  const siteId = getManagerSiteId(req);

  const logs = await prisma.temperatureLog.findMany({
    where: {
      siteId,
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
  const siteId = getManagerSiteId(req);

  const taskWhere = applyDepartmentScope(req, {
    siteId,
    completedAt: completedAt ? completedAt : { not: null },
  });

  const tasks = await prisma.task.findMany({
    where: taskWhere,
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
  const siteId = getManagerSiteId(req);

  try {
    const existing = await prisma.temperatureLog.findFirst({
      where: {
        id,
        siteId,
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
  const { name, assignedUserId, department, frequency } = req.body;

  if (!name || !assignedUserId) {
    return res.status(400).json({ error: "name and assignedUserId are required" });
  }

  const siteId = getManagerSiteId(req);
  const task = await prisma.task.create({
    data: {
      name,
      assignedUserId: Number(assignedUserId),
      department: department || "kitchen",
      frequency: frequency || "daily",
      siteId,
    },
  });

  res.json(task);
});

app.post("/manager/tasks/reset", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  await prisma.task.updateMany({
    where: {
      siteId,
    },
    data: {
      completed: false,
      completedAt: null,
    },
  });

  res.json({ success: true });
});

app.get("/manager/task-templates", requireAuth, requireManager, async (_req, res) => {
  const templates = await prisma.taskTemplate.findMany({
    orderBy: { id: "asc" },
  });

  res.json(templates);
});

app.post("/manager/task-templates", requireAuth, requireManager, async (req, res) => {
  const {
    name,
    department,
    frequency,
    areaId,
    equipmentId,
    venueType,
    autoCreate,
    schedule,
    safeMethodId,
    verificationRequired,
    managerSignoffRequired,
    correctiveActionPrompt,
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Template name is required" });
  }

  const template = await prisma.taskTemplate.create({
    data: {
      name,
      department: department || "kitchen",
      frequency: frequency || "daily",
      areaId: areaId ? Number(areaId) : null,
      equipmentId: equipmentId ? Number(equipmentId) : null,
      venueType: venueType || null,
      autoCreate: Boolean(autoCreate),
      schedule: schedule || null,
      safeMethodId: safeMethodId ? Number(safeMethodId) : null,
      verificationRequired: Boolean(verificationRequired),
      managerSignoffRequired: Boolean(managerSignoffRequired),
      correctiveActionPrompt: correctiveActionPrompt || null,
    },
  });

  res.json(template);
});

app.post("/manager/task-templates/apply", requireAuth, requireManager, async (req, res) => {
  const { templateId, assignedUserId, siteId } = req.body;

  if (!templateId || !assignedUserId) {
    return res.status(400).json({ error: "templateId and assignedUserId are required" });
  }

  try {
    const template = await prisma.taskTemplate.findUnique({
      where: { id: Number(templateId) },
    });

    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    const today = new Date().toISOString().slice(0, 10);

    const assignedUser = await prisma.user.findUnique({
      where: { id: Number(assignedUserId) },
    });

    if (!assignedUser) {
      return res.status(404).json({ error: "Assigned user not found" });
    }

    const task = await prisma.task.create({
      data: {
        name: template.name,
        department: template.department,
        frequency: template.frequency,
        templateId: template.id,
        taskDate: today,
        dueAt: buildDueAt(today, template.dueHour, template.dueMinute),
        assignedUserId: Number(assignedUserId),
        siteId: req.currentUser.siteId,
      },
    });

    res.json(task);
  } catch (error) {
    console.error("APPLY TEMPLATE ERROR:", error);

    res.status(400).json({
      error: "Could not apply template",
      details: error?.message || String(error),
    });
  }
});

app.get("/manager/compliance-dashboard", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);

  const tasks = await prisma.task.findMany({
    where: { siteId },
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.completed).length;
  const overdueTasks = tasks.filter(
    (task) => !task.completed && task.dueAt && new Date(task.dueAt) < new Date()
  ).length;
  const escalatedTasks = tasks.filter((task) => task.escalationLevel > 0).length;

  const departmentBreakdown = {};

  for (const task of tasks) {
    const dept = task.department || "unknown";

    if (!departmentBreakdown[dept]) {
      departmentBreakdown[dept] = {
        total: 0,
        completed: 0,
        overdue: 0,
        escalated: 0,
      };
    }

    departmentBreakdown[dept].total += 1;

    if (task.completed) departmentBreakdown[dept].completed += 1;
    if (!task.completed && task.dueAt && new Date(task.dueAt) < new Date()) {
      departmentBreakdown[dept].overdue += 1;
    }
    if (task.escalationLevel > 0) {
      departmentBreakdown[dept].escalated += 1;
    }
  }

  res.json({
    siteId,
    totalTasks,
    completedTasks,
    overdueTasks,
    escalatedTasks,
    completionRate:
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
    departmentBreakdown,
  });
});

app.get("/manager/compliance-dashboard/details", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  const { department, type } = req.query;
  const now = new Date();

  const where = {
    siteId,
    ...(department && department !== "all" ? { department: String(department) } : {}),
  };

  if (type === "completed") where.completed = true;
  if (type === "open") where.completed = false;
  if (type === "overdue") {
    where.completed = false;
    where.dueAt = { not: null, lt: now };
  }
  if (type === "escalated") {
    where.escalationLevel = { gt: 0 };
  }

  const tasks = await prisma.task.findMany({
    where,
    include: {
      assignedUser: true,
      site: true,
    },
    orderBy: [
      { escalationLevel: "desc" },
      { dueAt: "asc" },
      { id: "asc" },
    ],
  });

  res.json(
    tasks.map((task) => ({
      id: task.id,
      name: task.name,
      department: task.department,
      frequency: task.frequency,
      completed: task.completed,
      completedAt: task.completedAt,
      completedById: task.completedById,
      completedByEmail: task.completedByEmail,
      dueAt: task.dueAt,
      escalationLevel: task.escalationLevel,
      assignedUser: task.assignedUser
        ? { id: task.assignedUser.id, email: task.assignedUser.email }
        : null,
      site: task.site ? { id: task.site.id, name: task.site.name } : null,
    }))
  );
});

app.get("/manager/staff-performance", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);

  const users = await prisma.user.findMany({
    where: { siteId },
    include: {
      tasks: true,
    },
    orderBy: { id: "asc" },
  });

  const performance = users.map((user) => {
    const totalTasks = user.tasks.length;
    const completedTasks = user.tasks.filter((task) => task.completed).length;
    const overdueTasks = user.tasks.filter(
      (task) => !task.completed && task.dueAt && new Date(task.dueAt) < new Date()
    ).length;
    const escalatedTasks = user.tasks.filter((task) => task.escalationLevel > 0).length;

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      siteId: user.siteId,
      totalTasks,
      completedTasks,
      overdueTasks,
      escalatedTasks,
      completionRate:
        totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
    };
  });

  res.json(performance);
});

app.get("/manager/risk-insights", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);

  const tasks = await prisma.task.findMany({
    where: { siteId },
    include: { assignedUser: true },
  });

  const risks = [];

  const overdue = tasks.filter(
    (task) => !task.completed && task.dueAt && new Date(task.dueAt) < now
  );

  if (overdue.length > 0) {
    risks.push({
      level: "high",
      title: "Overdue tasks need attention",
      message: `${overdue.length} tasks are currently overdue.`,
      type: "overdue_tasks",
    });
  }

  const escalated = tasks.filter((task) => task.escalationLevel > 0);

  if (escalated.length > 0) {
    risks.push({
      level: "high",
      title: "Escalations active",
      message: `${escalated.length} tasks have escalated.`,
      type: "escalations",
    });
  }

  const departmentStats = {};

  for (const task of tasks) {
    const dept = task.department || "unknown";

    if (!departmentStats[dept]) {
      departmentStats[dept] = { total: 0, completed: 0, overdue: 0, escalated: 0 };
    }

    departmentStats[dept].total += 1;
    if (task.completed) departmentStats[dept].completed += 1;
    if (!task.completed && task.dueAt && new Date(task.dueAt) < now) {
      departmentStats[dept].overdue += 1;
    }
    if (task.escalationLevel > 0) {
      departmentStats[dept].escalated += 1;
    }
  }

  for (const [department, stats] of Object.entries(departmentStats)) {
    const completionRate =
      stats.total === 0 ? 100 : Math.round((stats.completed / stats.total) * 100);

    if (completionRate < 50) {
      risks.push({
        level: "high",
        title: `${department} compliance risk`,
        message: `${department} completion rate is only ${completionRate}%.`,
        type: "department_completion",
        department,
      });
    } else if (completionRate < 80) {
      risks.push({
        level: "medium",
        title: `${department} needs monitoring`,
        message: `${department} completion rate is ${completionRate}%.`,
        type: "department_completion",
        department,
      });
    }
  }

  const staffStats = {};

  for (const task of tasks) {
    if (!task.assignedUser) continue;

    const key = task.assignedUser.id;

    if (!staffStats[key]) {
      staffStats[key] = {
        email: task.assignedUser.email,
        total: 0,
        completed: 0,
        overdue: 0,
        escalated: 0,
      };
    }

    staffStats[key].total += 1;
    if (task.completed) staffStats[key].completed += 1;
    if (!task.completed && task.dueAt && new Date(task.dueAt) < now) {
      staffStats[key].overdue += 1;
    }
    if (task.escalationLevel > 0) {
      staffStats[key].escalated += 1;
    }
  }

  for (const staff of Object.values(staffStats)) {
    const completionRate =
      staff.total === 0 ? 100 : Math.round((staff.completed / staff.total) * 100);

    if (staff.overdue >= 3 || staff.escalated >= 2 || completionRate < 50) {
      risks.push({
        level: "high",
        title: `${staff.email} may need support`,
        message: `${staff.email} has ${staff.overdue} overdue and ${staff.escalated} escalated tasks. Completion rate: ${completionRate}%.`,
        type: "staff_risk",
        staffEmail: staff.email,
      });
    }
  }

  res.json({
    siteId,
    generatedAt: now.toISOString(),
    riskCount: risks.length,
    risks,
  });
});

app.get("/manager/executive-report", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: { siteId },
    include: { assignedUser: true, site: true },
  });

  const shifts = await prisma.shift.findMany({
    where: { siteId },
    orderBy: { startedAt: "desc" },
    take: 20,
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.completed).length;
  const overdueTasks = tasks.filter(
    (task) => !task.completed && task.dueAt && new Date(task.dueAt) < now
  );
  const escalatedTasks = tasks.filter((task) => task.escalationLevel > 0);

  const staff = {};

  for (const task of tasks) {
    if (!task.assignedUser) continue;

    const key = task.assignedUser.email;

    if (!staff[key]) {
      staff[key] = {
        email: task.assignedUser.email,
        total: 0,
        completed: 0,
        overdue: 0,
        escalated: 0,
      };
    }

    staff[key].total += 1;
    if (task.completed) staff[key].completed += 1;
    if (!task.completed && task.dueAt && new Date(task.dueAt) < now) staff[key].overdue += 1;
    if (task.escalationLevel > 0) staff[key].escalated += 1;
  }

  const staffPerformance = Object.values(staff).map((member) => ({
    ...member,
    completionRate:
      member.total === 0 ? 0 : Math.round((member.completed / member.total) * 100),
  }));

  res.json({
    generatedAt: now.toISOString(),
    siteId,
    summary: {
      totalTasks,
      completedTasks,
      overdueTasks: overdueTasks.length,
      escalatedTasks: escalatedTasks.length,
      completionRate:
        totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
    },
    staffPerformance,
    recentShifts: shifts,
    keyIssues: [
      ...overdueTasks.slice(0, 10).map((task) => ({
        type: "overdue",
        task: task.name,
        assignedTo: task.assignedUser?.email || "Unassigned",
        dueAt: task.dueAt,
      })),
      ...escalatedTasks.slice(0, 10).map((task) => ({
        type: "escalated",
        task: task.name,
        assignedTo: task.assignedUser?.email || "Unassigned",
        escalationLevel: task.escalationLevel,
      })),
    ],
  });
});

app.get("/manager/executive-report/pdf", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: { siteId },
    include: { assignedUser: true, site: true },
  });

  const shifts = await prisma.shift.findMany({
    where: { siteId },
    orderBy: { startedAt: "desc" },
    take: 20,
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.completed).length;
  const overdueTasks = tasks.filter(
    (task) => !task.completed && task.dueAt && new Date(task.dueAt) < now
  );
  const escalatedTasks = tasks.filter((task) => task.escalationLevel > 0);

  const staff = {};

  for (const task of tasks) {
    if (!task.assignedUser) continue;

    const key = task.assignedUser.email;

    if (!staff[key]) {
      staff[key] = {
        email: task.assignedUser.email,
        total: 0,
        completed: 0,
        overdue: 0,
        escalated: 0,
      };
    }

    staff[key].total += 1;
    if (task.completed) staff[key].completed += 1;
    if (!task.completed && task.dueAt && new Date(task.dueAt) < now) staff[key].overdue += 1;
    if (task.escalationLevel > 0) staff[key].escalated += 1;
  }

  const staffPerformance = Object.values(staff).map((member) => ({
    ...member,
    completionRate:
      member.total === 0 ? 0 : Math.round((member.completed / member.total) * 100),
  }));

  const summary = {
    totalTasks,
    completedTasks,
    overdueTasks: overdueTasks.length,
    escalatedTasks: escalatedTasks.length,
    completionRate:
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
  };

  const recentShifts = shifts;

  const keyIssues = [
    ...overdueTasks.slice(0, 10).map((task) => ({
      type: "overdue",
      task: task.name,
      assignedTo: task.assignedUser?.email || "Unassigned",
      dueAt: task.dueAt,
    })),
    ...escalatedTasks.slice(0, 10).map((task) => ({
      type: "escalated",
      task: task.name,
      assignedTo: task.assignedUser?.email || "Unassigned",
      escalationLevel: task.escalationLevel,
    })),
  ];

  const doc = new PDFDocument({ margin: 40 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=executive-report.pdf"
  );

  doc.pipe(res);

  doc.fontSize(22).text("Executive Operations Report");
  doc.moveDown();

  doc.fontSize(16).text("Summary");
  doc.fontSize(12).text(`Total Tasks: ${summary.totalTasks}`);
  doc.text(`Completed: ${summary.completedTasks}`);
  doc.text(`Overdue: ${summary.overdueTasks}`);
  doc.text(`Escalated: ${summary.escalatedTasks}`);
  doc.text(`Completion Rate: ${summary.completionRate}%`);

  doc.moveDown();

  doc.fontSize(16).text("Staff Performance");

  staffPerformance.forEach((staff) => {
    doc.fontSize(12).text(
      `${staff.email} | Completion: ${staff.completionRate}% | Overdue: ${staff.overdue} | Escalated: ${staff.escalated}`
    );
  });

  doc.moveDown();

  doc.fontSize(16).text("Recent Shift Handovers");

  recentShifts.forEach((shift) => {
    doc.fontSize(12).text(
      `User ${shift.userId} | Started: ${new Date(
        shift.startedAt
      ).toLocaleString()} | Ended: ${
        shift.endedAt
          ? new Date(shift.endedAt).toLocaleString()
          : "Still open"
      }`
    );

    if (shift.handoverNotes) {
      doc.text(`Notes: ${shift.handoverNotes}`);
    }

    doc.moveDown(0.5);
  });

  doc.moveDown();

  doc.fontSize(16).text("Key Issues");

  keyIssues.forEach((issue) => {
    doc.fontSize(12).text(
      `${issue.type.toUpperCase()} - ${issue.task} - ${issue.assignedTo}`
    );
  });

  doc.moveDown();

  doc.fontSize(10).text(
    `Generated: ${new Date().toLocaleString()}`
  );

  doc.end();
});

app.get("/manager/priority-queue", requireAuth, requireManager, async (req, res) => {
  const siteId = getManagerSiteId(req);
  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: {
      siteId,
      completed: false,
    },
    include: {
      assignedUser: true,
      site: true,
    },
    orderBy: [
      { escalationLevel: "desc" },
      { dueAt: "asc" },
      { id: "asc" },
    ],
  });

  const priorityTasks = tasks.map((task) => {
    let priority = "on_track";

    if (task.dueAt && new Date(task.dueAt) < now) {
      priority = "overdue";
    } else if (task.escalationLevel > 0) {
      priority = "escalated";
    } else if (task.dueAt) {
      const hoursUntilDue =
        (new Date(task.dueAt).getTime() - now.getTime()) / (1000 * 60 * 60);

      if (hoursUntilDue <= 2) {
        priority = "due_soon";
      }
    }

    return {
      id: task.id,
      name: task.name,
      department: task.department,
      frequency: task.frequency,
      dueAt: task.dueAt,
      escalationLevel: task.escalationLevel,
      priority,
      assignedUser: task.assignedUser
        ? {
            id: task.assignedUser.id,
            email: task.assignedUser.email,
          }
        : null,
      site: task.site
        ? {
            id: task.site.id,
            name: task.site.name,
          }
        : null,
    };
  });

  priorityTasks.sort((a, b) => {
    const order = {
      overdue: 1,
      escalated: 2,
      due_soon: 3,
      on_track: 4,
    };

    return order[a.priority] - order[b.priority];
  });

  res.json(priorityTasks);
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

function shouldGenerateTemplate(template, now = new Date()) {
  const hour = now.getHours();
  const day = now.getDay();
  const date = now.getDate();

  switch (template.schedule) {
    case "opening":
      return hour >= 5 && hour < 8;

    case "closing":
      return hour >= 16 && hour < 23;

    case "weekly_monday":
      return day === 1;

    case "monthly_1st":
      return date === 1;

    default:
      return true;
  }
}

function buildDueAt(taskDate, dueHour, dueMinute) {
  if (dueHour === null || dueHour === undefined) return null;

  const dueAt = new Date(`${taskDate}T00:00:00.000Z`);
  dueAt.setUTCHours(Number(dueHour), Number(dueMinute || 0), 0, 0);

  return dueAt;
}

app.post("/internal/generate-template-tasks", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== `Bearer ${INTERNAL_RESET_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const allTemplates = await prisma.taskTemplate.findMany({
      where: {
        autoCreate: true,
      },
      orderBy: { id: "asc" },
    });

    const templates = allTemplates.filter((template) =>
      shouldGenerateTemplate(template, now)
    );

    const users = await prisma.user.findMany({
      where: {
        role: {
          in: ["staff", "department_manager"],
        },
        siteId: {
          not: null,
        },
      },
    });

    const created = [];
    const skipped = [];

    for (const template of templates) {
      if (!shouldGenerateTemplate(template)) {
        continue;
      }

      const matchingUsers = users.filter(
        (user) =>
          user.department === template.department ||
          !user.department
      );

      for (const user of matchingUsers) {
        const existing = await prisma.task.findFirst({
          where: {
            templateId: template.id,
            taskDate: today,
            assignedUserId: user.id,
            siteId: user.siteId,
          },
        });

        if (existing) {
          skipped.push({
            templateId: template.id,
            userId: user.id,
            reason: "Already exists",
          });
          continue;
        }

        if (template.areaId) {
          const area = await prisma.area.findFirst({
            where: {
              id: template.areaId,
              siteId: user.siteId,
              active: true,
            },
          });

          if (!area) continue;
        }

        if (template.equipmentId) {
          const equipment = await prisma.equipment.findFirst({
            where: {
              id: template.equipmentId,
              siteId: user.siteId,
              active: true,
            },
          });

          if (!equipment) continue;
        }

        const dueAt = buildDueAt(today, template.dueHour, template.dueMinute);

        const task = await prisma.task.create({
          data: {
            name: template.name,
            department: template.department,
            frequency: template.frequency,
            templateId: template.id,
            taskDate: today,
            assignedUserId: user.id,
            siteId: user.siteId,
            dueAt,
          },
        });

        created.push(task);
      }
    }

    res.json({
      success: true,
      taskDate: today,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped,
    });
  } catch (error) {
    console.error("GENERATE TEMPLATE TASKS ERROR:", error);
    res.status(500).json({ error: "Could not generate template tasks" });
  }
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

app.post("/internal/check-overdue-tasks", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== `Bearer ${INTERNAL_RESET_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = new Date();

    const overdueTasks = await prisma.task.findMany({
      where: {
        completed: false,
        dueAt: {
          not: null,
          lt: now,
        },
      },
      include: {
        site: true,
        assignedUser: true,
      },
    });

    const escalated = [];

    for (const task of overdueTasks) {
      const nextLevel = Math.min((task.escalationLevel || 0) + 1, 3);

      let managers = [];

      if (nextLevel === 1) {
        managers = await prisma.user.findMany({
          where: {
            role: "department_manager",
            department: task.department,
            siteId: task.siteId,
            pushToken: { not: null },
          },
        });
      }

      if (nextLevel === 2) {
        managers = await prisma.user.findMany({
          where: {
            role: "manager",
            siteId: task.siteId,
            pushToken: { not: null },
          },
        });
      }

      if (nextLevel === 3) {
        managers = await prisma.user.findMany({
          where: {
            role: {
              in: ["owner", "regional_manager", "area_manager"],
            },
            pushToken: { not: null },
          },
        });
      }

      const messages = managers.map((manager) => ({
        to: manager.pushToken,
        sound: "default",
        title: "Overdue compliance task",
        body: `${task.name} is overdue at ${task.site?.name || "site"}`,
        data: {
          screen: "manager",
          taskId: task.id,
          escalationLevel: nextLevel,
        },
      }));

      if (messages.length > 0) {
        await sendExpoPushNotifications(messages);
      }

      const updatedTask = await prisma.task.update({
        where: { id: task.id },
        data: {
          escalationLevel: nextLevel,
          lastEscalatedAt: now,
        },
      });

      escalated.push({
        taskId: updatedTask.id,
        name: updatedTask.name,
        escalationLevel: updatedTask.escalationLevel,
        notifiedManagers: messages.length,
      });
    }

    res.json({
      success: true,
      checkedAt: now.toISOString(),
      overdueCount: overdueTasks.length,
      escalated,
    });
  } catch (error) {
    console.error("CHECK OVERDUE TASKS ERROR:", error);
    res.status(500).json({ error: "Could not check overdue tasks" });
  }
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

// Hard-coded venue setup presets
const VENUE_SETUP_PRESETS = [
  {
    id: "pub",
    name: "Pub",

    areas: [
      {
        name: "Main Bar",
        category: "front_of_house",
        department: "front_of_house",

        equipment: [
          {
            name: "Main Glass Washer",
            type: "glasswasher",
            cleaningIntervalDays: 1,
            maintenanceIntervalDays: 30,
            taskName: "Clean glass washer",
            frequency: "daily",
          },

          {
            name: "Bottle Fridge 1",
            type: "bottle_fridge",
            cleaningIntervalDays: 7,
            maintenanceIntervalDays: 30,
            taskName: "Check bottle fridge temperature",
            frequency: "daily",
          },

          {
            name: "Ice Machine",
            type: "ice_machine",
            cleaningIntervalDays: 7,
            maintenanceIntervalDays: 30,
            taskName: "Clean ice machine",
            frequency: "weekly",
          },

          {
            name: "Coffee Machine",
            type: "coffee_machine",
            cleaningIntervalDays: 1,
            maintenanceIntervalDays: 30,
            taskName: "Clean coffee machine",
            frequency: "daily",
          },
        ],
      },

      {
        name: "Kitchen",
        category: "kitchen",
        department: "kitchen",

        equipment: [
          {
            name: "Walk-in Fridge",
            type: "fridge",
            cleaningIntervalDays: 7,
            maintenanceIntervalDays: 30,
            taskName: "Check walk-in fridge temperature",
            frequency: "daily",
          },

          {
            name: "Freezer",
            type: "freezer",
            cleaningIntervalDays: 7,
            maintenanceIntervalDays: 30,
            taskName: "Check freezer temperature",
            frequency: "daily",
          },
        ],
      },

      {
        name: "Cellar",
        category: "cellar",
        department: "cellar",

        equipment: [
          {
            name: "Beer Cellar Cooling",
            type: "beer_cellar",
            cleaningIntervalDays: 30,
            maintenanceIntervalDays: 90,
            taskName: "Inspect cellar cooling",
            frequency: "weekly",
          },
        ],
      },
    ],

    tasks: [
      {
        name: "Check toilets are clean and stocked",
        department: "front_of_house",
        frequency: "daily",
      },

      {
        name: "Complete opening checks",
        department: "front_of_house",
        frequency: "daily",
      },

      {
        name: "Complete kitchen cleaning schedule",
        department: "kitchen",
        frequency: "daily",
      },
    ],
  },

  {
    id: "chip_shop",
    name: "Chip Shop",
    departments: [
      "kitchen",
      "front_of_house",
      "cleaning",
    ],
    equipment: [
      { type: "fryer", quantity: 3 },
      { type: "freezer", quantity: 2 },
      { type: "hot_holding", quantity: 1 },
      { type: "extraction", quantity: 1 },
    ],
    templatePackIds: [
      "kitchen_cleaning",
    ],
  },
];

// Hard-coded template packs
const TEMPLATE_PACKS = [
  {
    id: "foh_opening",
    name: "FoH Opening Pack",
    templates: [
      {
        name: "Opening: Check toilets are clean and stocked",
        department: "front_of_house",
        schedule: "opening",
        dueHour: 10,
        dueMinute: 0,
        autoCreate: true,
      },
      {
        name: "Opening: Check bar is clean and ready",
        department: "front_of_house",
        schedule: "opening",
        dueHour: 10,
        dueMinute: 0,
        autoCreate: true,
      },
      {
        name: "Opening: Check backfitting and bar counter",
        department: "front_of_house",
        schedule: "opening",
        dueHour: 10,
        dueMinute: 0,
        autoCreate: true,
      },
      {
        name: "Opening: Check cellar is ready",
        department: "front_of_house",
        schedule: "opening",
        dueHour: 10,
        dueMinute: 0,
        autoCreate: true,
      },
      {
        name: "Opening: Check tills are prepared",
        department: "front_of_house",
        schedule: "opening",
        dueHour: 10,
        dueMinute: 0,
        autoCreate: true,
      },
      {
        name: "Opening: Check public areas are clean and ready",
        department: "front_of_house",
        schedule: "opening",
        dueHour: 10,
        dueMinute: 0,
        autoCreate: true,
      },
    ],
  },
  {
    id: "kitchen_cleaning",
    name: "Kitchen SFBB Cleaning Pack",
    templates: [
      {
        name: "Clean work surfaces",
        department: "kitchen",
        schedule: "daily",
        dueHour: 11,
        dueMinute: 0,
        autoCreate: true,
      },
      {
        name: "Clean fridges and freezers",
        department: "kitchen",
        schedule: "weekly",
        dueHour: 11,
        dueMinute: 0,
        autoCreate: true,
      },
    ],
  },
];

// Template Packs routes
app.get("/manager/template-packs", requireAuth, requireManager, (_req, res) => {
  res.json(TEMPLATE_PACKS);
});

app.post("/manager/template-packs/:packId/import", requireAuth, requireManager, async (req, res) => {
  const pack = TEMPLATE_PACKS.find((item) => item.id === req.params.packId);

  if (!pack) {
    return res.status(404).json({ error: "Template pack not found" });
  }

  const created = [];
  const skipped = [];

  for (const template of pack.templates) {
    const existing = await prisma.taskTemplate.findFirst({
      where: {
        name: template.name,
        department: template.department,
        schedule: template.schedule || null,
        venueType: template.venueType || null,
      },
    });

    if (existing) {
      skipped.push(existing);
      continue;
    }

    const newTemplate = await prisma.taskTemplate.create({
      data: {
        ...template,
      },
    });

    created.push(newTemplate);
  }

  res.json({
    success: true,
    created,
    skipped,
    counts: {
      created: created.length,
      skipped: skipped.length,
    },
  });
});

app.get("/manager/equipment-status", requireAuth, requireManager, async (req, res) => {
  try {
    const siteId = getManagerSiteId(req);

    const equipment = await prisma.equipment.findMany({
      where: { siteId },
      include: { area: true },
      orderBy: { id: "asc" },
    });

    const now = new Date();

    const cleaningDue = equipment.filter(
      (item) => item.nextCleaningDueAt && new Date(item.nextCleaningDueAt) <= now
    ).length;

    const maintenanceDue = equipment.filter(
      (item) => item.nextMaintenanceDueAt && new Date(item.nextMaintenanceDueAt) <= now
    ).length;

    const summary = {
      total: equipment.length,
      faultReported: equipment.filter((item) => item.faultReported).length,
      outOfService: equipment.filter((item) => item.outOfService).length,
      cleaningDue,
      maintenanceDue,
    };

    res.json({ summary, equipment, cleaningDue, maintenanceDue });
  } catch (error) {
    console.error("EQUIPMENT STATUS ERROR:", error);
    res.status(500).json({ error: "Could not load equipment status" });
  }
});
