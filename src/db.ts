/** Cliente Prisma único (singleton), reaproveitado por todo o serviço. */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: ["warn", "error"],
});
