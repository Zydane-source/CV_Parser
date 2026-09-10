import { env } from "@/lib/config";
import type { OCRProvider } from "./types";
import { TesseractOCRProvider } from "./tesseract-provider";

export type { OCRProvider, OCROptions, OCRResult } from "./types";

let instance: OCRProvider | null = null;

/**
 * Resolve the configured OCR provider. Add new providers here; the pipeline only
 * depends on the OCRProvider interface.
 */
export function getOCRProvider(): OCRProvider {
  if (instance) return instance;
  const e = env();
  switch (e.OCR_PROVIDER) {
    case "tesseract":
      instance = new TesseractOCRProvider(e.OCR_CACHE_PATH);
      return instance;
    default:
      throw new Error(`Unknown OCR_PROVIDER "${e.OCR_PROVIDER}". Supported: tesseract`);
  }
}

/** For tests / shutdown. */
export function setOCRProvider(p: OCRProvider | null) {
  instance = p;
}

export async function shutdownOCR() {
  if (instance?.terminate) await instance.terminate();
  instance = null;
}
