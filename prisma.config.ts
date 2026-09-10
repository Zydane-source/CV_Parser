import "dotenv/config";
import { defineConfig } from "prisma/config";

/** Prisma CLI configuration: schema in database/schema, migrations in database/migrations. */
export default defineConfig({
  schema: "database/schema/schema.prisma",
  migrations: {
    path: "database/migrations",
    seed: "tsx scripts/seed-admin.ts",
  },
});
