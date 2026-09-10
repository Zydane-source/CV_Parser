import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import type { OCROptions, OCRProvider, OCRResult } from "./types";
import { renderPdfPagesToImages } from "./pdf-render";

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

  constructor(cachePath: string) {
    this.cachePath = path.resolve(cachePath);
  }

  private async getWorker(langs: string): Promise<TesseractWorker> {
    if (this.worker && this.workerLangs === langs) return this.worker;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    await fs.mkdir(this.cachePath, { recursive: true });
    const { createWorker } = await import("tesseract.js");
    const langList = langs.split(/[+,]/).map((l) => l.trim()).filter(Boolean);
    this.worker = await createWorker(langList, 1, {
      cachePath: this.cachePath,
      gzip: true,
    });
    this.workerLangs = langs;
    return this.worker;
  }

  /** Serialise OCR calls – a Tesseract worker handles one image at a time. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Normalise the input for OCR: PNG, grayscale, upscaled if small, sharpened. */
  static async preprocess(image: Buffer): Promise<Buffer> {
    const meta = await sharp(image).metadata();
    const width = meta.width ?? 0;
    let pipeline = sharp(image).rotate().grayscale().normalise();
    if (width > 0 && width < 1400) {
      pipeline = pipeline.resize({ width: Math.min(width * 2, 2400), withoutEnlargement: false });
    }
    return pipeline.sharpen().png().toBuffer();
  }

  private async recognize(image: Buffer, langs: string): Promise<{ text: string; confidence: number }> {
    const worker = await this.getWorker(langs);
    const prepared = await TesseractOCRProvider.preprocess(image);
    const { data } = await worker.recognize(prepared);
    return { text: data.text ?? "", confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)) };
  }

  async extractFromImage(image: Buffer, _mimeType: string, opts: OCROptions): Promise<OCRResult> {
    return this.run(async () => {
      const r = await this.recognize(image, opts.languages);
      return { text: r.text, confidence: r.confidence, pagesProcessed: 1 };
    });
  }

  async extractFromScannedPDF(pdf: Buffer, opts: OCROptions): Promise<OCRResult> {
    const pages = await renderPdfPagesToImages(pdf, opts.maxPages);
    return this.run(async () => {
      const texts: string[] = [];
      let confSum = 0;
      for (const page of pages) {
        const r = await this.recognize(page, opts.languages);
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
