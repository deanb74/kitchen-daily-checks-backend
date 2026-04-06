import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  let user = await prisma.user.findUnique({
    where: { email: "test@test.com" },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: "test@test.com",
        password: bcrypt.hashSync("123456", 10),
      },
    });
    console.log("Seeded user");
  } else {
    console.log("User already exists");
  }

  const taskCount = await prisma.task.count();

  if (taskCount === 0) {
    await prisma.task.createMany({
      data: [
        { name: "Fridge Temperature Check", assignedUserId: user.id },
        { name: "Clean Prep Surface", assignedUserId: user.id },
        { name: "Delivery Inspection", assignedUserId: user.id }
      ],
    });
    console.log("Seeded tasks");
  } else {
    console.log("Tasks already exist");
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });