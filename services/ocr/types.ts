/**
 * OCR provider abstraction. Swap providers (Tesseract, Google Vision, AWS Textract,
 * a vision LLM ...) by implementing this interface and registering it in index.ts.
 */
export interface OCRResult {
  text: string;
  /** Provider-reported confidence 0..1 (average word confidence for Tesseract). */
  confidence: number;
  pagesProcessed: number;
}

export interface OCROptions {
  languages: string;
  maxPages: number;
}

export interface OCRProvider {
  readonly name: string;
  extractFromImage(image: Buffer, mimeType: string, opts: OCROptions): Promise<OCRResult>;
  extractFromScannedPDF(pdf: Buffer, opts: OCROptions): Promise<OCRResult>;
  /** Release worker resources (called on shutdown). */
  terminate?(): Promise<void>;
}
