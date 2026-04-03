import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const taskCount = await prisma.task.count();

  if (taskCount === 0) {
    await prisma.task.createMany({
      data: [
        { name: "Fridge Temperature Check" },
        { name: "Clean Prep Surface" },
        { name: "Delivery Inspection" }
      ]
    });
    console.log("Seeded tasks");
  } else {
    console.log("Tasks already exist");
  }

  const userCount = await prisma.user.count();

  if (userCount === 0) {
    await prisma.user.create({
      data: {
        email: "test@test.com",
        password: "123456"
      }
    });
    console.log("Seeded user");
  } else {
    console.log("Users already exist");
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