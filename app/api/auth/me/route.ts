import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const GET = handler(async () => {
  const user = await requireUser();
  return ok({ user });
});
