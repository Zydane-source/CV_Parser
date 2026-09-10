import { handler, ok, parseJson } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { publicConfigSummary } from "@/lib/config";
import { getSettings, settingsSchema, updateSettings } from "@/lib/settings";
import { availablePromptVersions } from "@/services/llm/prompts";

export const dynamic = "force-dynamic";

/** GET /api/settings – runtime settings + non-secret environment summary. */
export const GET = handler(async () => {
  await requireUser();
  return ok({ settings: await getSettings(), env: publicConfigSummary(), promptVersions: availablePromptVersions() });
});

/** PATCH /api/settings – admin only. Secrets cannot be set here (env only). */
export const PATCH = handler(async (req: Request) => {
  await requireAdmin();
  const patch = await parseJson(req, settingsSchema.partial());
  const settings = await updateSettings(patch);
  return ok({ settings });
});
