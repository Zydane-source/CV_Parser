import { env } from "./config";
import { isRedisConfigured } from "./redis";

/**
 * The processing mode the app can actually honour, which is not always the one
 * that was configured.
 *
 * `queue` needs two things the platform may not provide: a reachable Redis, and
 * somewhere to run a long-lived worker. A serverless deployment configured with
 * `PROCESSING_MODE=queue` and no usable Redis has neither, and every upload
 * would record a job that nothing will ever consume — CVs sitting at Pending
 * with no explanation.
 *
 * Rather than leave the deployment broken, fall back to `inline`, where the
 * database row *is* the queue and `/api/jobs/drain` does the work in short
 * bursts. The fallback is logged once and reported by `/api/health` and the
 * Settings page, so it is visible rather than mysterious.
 */
let warned = false;

export function effectiveProcessingMode(): "queue" | "inline" {
  const configured = env().PROCESSING_MODE;
  if (configured === "inline") return "inline";
  if (isRedisConfigured()) return "queue";

  if (!warned) {
    warned = true;
    console.warn(
      "[config] PROCESSING_MODE=queue, but REDIS_URL is not usable from here " +
        "(unset, loopback on a serverless platform, or unreachable). Falling back to inline processing. " +
        "Set PROCESSING_MODE=inline to make this explicit, or point REDIS_URL at a reachable Redis.",
    );
  }
  return "inline";
}

/** True when the mode in force differs from the one that was configured. */
export function processingModeWasDowngraded(): boolean {
  return env().PROCESSING_MODE === "queue" && effectiveProcessingMode() === "inline";
}
