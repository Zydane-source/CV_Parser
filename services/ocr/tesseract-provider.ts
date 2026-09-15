import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import type { OCROptions, OCRProvider, OCRResult } from "./types";
import { renderPdfPagesToImages } from "./pdf-render";
import { withTimeout } from "@/lib/timeout";

/**
 * Longest a single OCR call may take before it is abandoned.
 *
 * A healthy recognition takes one to three seconds. Anything past this is a
 * wedged worker, and on a serverless platform waiting for it means the whole
 * invocation — and every CV queued behind it — dies at the platform limit.
 */
const RECOGNIZE_TIMEOUT_MS = 25_000;

type TesseractWorker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

/**
 * Tesseract.js OCR provider. Runs fully locally (WASM) – no credential needed.
 * Language data (~4MB per language) is downloaded once into OCR_CACHE_PATH.
 * One worker per process is reused across jobs; recognition calls are serialised.
 */
export class TesseractOCRProvider implements OCRProvider {
  readonly name = "tesseract";
  private worker: TesseractWorker | null = null;
  private workerLangs = "";
  private queue: Promise<unknown> = Promise.resolve();
  private cachePath: string;
  private pdfScale: number;

  /**
   * @param pdfScale How large scanned PDF pages are rendered for OCR, relative to
   *   72 dpi. Rendered pages go to Tesseract as they are — see preprocess.
   */
  constructor(cachePath: string, opts: { pdfScale?: number } = {}) {
    this.cachePath = path.resolve(cachePath);
    this.pdfScale = opts.pdfScale ?? 2;
  }

  private async getWorker(langs: string): Promise<TesseractWorker> {
    if (this.worker && this.workerLangs === langs) return this.worker;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    // A read-only filesystem is fine if the language data is already there.
    await fs.mkdir(this.cachePath, { recursive: true }).catch(() => undefined);
    const { createWorker } = await import("tesseract.js");
    const langList = langs.split(/[+,]/).map((l) => l.trim()).filter(Boolean);
    this.worker = await withTimeout(
      createWorker(langList, 1, {
        cachePath: this.cachePath,
        gzip: true,
        // Without a handler, an error inside the worker thread surfaces as an
        // uncaught exception in the host process instead of a rejected promise.
        errorHandler: (err: unknown) => {
          this.discardWorker();
          void err;
        },
      }),
      RECOGNIZE_TIMEOUT_MS,
      "OCR engine did not start in time",
    );
    this.workerLangs = langs;
    return this.worker;
  }

  /** Drop a worker that failed, so the next CV starts a fresh one instead of reusing a broken one. */
  private discardWorker() {
    const w = this.worker;
    this.worker = null;
    this.workerLangs = "";
    if (w) void w.terminate().catch(() => undefined);
  }

  /** Serialise OCR calls – a Tesseract worker handles one image at a time. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Normalise the input for OCR: PNG, grayscale, sharpened, and resized.
   *
   * Uploaded images are upscaled when small, because a phone screenshot of a CV
   * really is too coarse to read. Pages we rendered ourselves are not: the
   * renderer already chose their resolution, and doubling it again only
   * quadrupled the pixels Tesseract had to scan without adding any detail.
   */
  static async preprocess(image: Buffer, opts: { upscale?: boolean } = {}): Promise<Buffer> {
    const meta = await sharp(image).metadata();
    const width = meta.width ?? 0;
    let pipeline = sharp(image).rotate().grayscale().normalise();
    if ((opts.upscale ?? true) && width > 0 && width < 1400) {
      pipeline = pipeline.resize({ width: Math.min(width * 2, 2400), withoutEnlargement: false });
    } else if (width > 2600) {
      // A full-resolution phone photo: past this, more pixels cost time, not accuracy.
      pipeline = pipeline.resize({ width: 2400 });
    }
    return pipeline.sharpen().png().toBuffer();
  }

  private async recognize(image: Buffer, langs: string, upscale = true): Promise<{ text: string; confidence: number }> {
    try {
      const worker = await this.getWorker(langs);
      const prepared = await TesseractOCRProvider.preprocess(image, { upscale });
      const { data } = await withTimeout(worker.recognize(prepared), RECOGNIZE_TIMEOUT_MS, "OCR timed out on this page");
      return { text: data.text ?? "", confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)) };
    } catch (err) {
      this.discardWorker();
      throw err;
    }
  }

  async extractFromImage(image: Buffer, _mimeType: string, opts: OCROptions): Promise<OCRResult> {
    return this.run(async () => {
      const r = await this.recognize(image, opts.languages);
      return { text: r.text, confidence: r.confidence, pagesProcessed: 1 };
    });
  }

  async extractFromScannedPDF(pdf: Buffer, opts: OCROptions): Promise<OCRResult> {
    const pages = await renderPdfPagesToImages(pdf, opts.maxPages, this.pdfScale);
    return this.run(async () => {
      const texts: string[] = [];
      let confSum = 0;
      for (const page of pages) {
        const r = await this.recognize(page, opts.languages, false);
        texts.push(r.text);
        confSum += r.confidence;
      }
      return {
        text: texts.join("\n\n"),
        confidence: pages.length ? confSum / pages.length : 0,
        pagesProcessed: pages.length,
      };
    });
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}
