import { handler, ok, parseJson } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { publicConfigSummary } from "@/lib/config";
import { getSettings, settingsSchema, updateSettings } from "@/lib/settings";
import { availablePromptVersions } from "@/services/llm/prompts";
import { effectiveStorageDriver } from "@/services/storage";

export const dynamic = "force-dynamic";

/** GET /api/settings – runtime settings + non-secret environment summary. */
export const GET = handler(async () => {
  await requireUser();
  const env = publicConfigSummary();
  // What is configured and what is in force can differ when a setting cannot
  // be honoured here; showing only the former hides why uploads land where they do.
  return ok({
    settings: await getSettings(),
    env: { ...env, storage: { ...env.storage, effectiveDriver: effectiveStorageDriver() } },
    promptVersions: availablePromptVersions(),
  });
});

/** PATCH /api/settings – admin only. Secrets cannot be set here (env only). */
export const PATCH = handler(async (req: Request) => {
  await requireAdmin();
  const patch = await parseJson(req, settingsSchema.partial());
  const settings = await updateSettings(patch);
  return ok({ settings });
});
