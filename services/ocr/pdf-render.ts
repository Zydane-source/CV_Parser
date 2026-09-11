/**
 * Render PDF pages to PNG buffers (for OCR of scanned PDFs) using pdf.js + @napi-rs/canvas.
 *
 * unpdf types `canvasImport` as `@napi-rs/canvas` directly, so no casting is
 * needed: the renderer and the document factory both take the same importer.
 */
const canvasImport = () => import("@napi-rs/canvas");

export async function renderPdfPagesToImages(pdf: Buffer, maxPages: number, scale = 2): Promise<Buffer[]> {
  const { getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } = await import("unpdf");
  // pdf.js transfers (detaches) the byte buffer to its worker, so always hand it a copy.
  const data = new Uint8Array(pdf);
  // The document needs a canvas factory too: embedded images in scanned pages are
  // painted through the document's own factory, not the output canvas.
  const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
  const doc = await getDocumentProxy(data, { CanvasFactory });
  try {
    const pages = Math.min(doc.numPages, Math.max(1, maxPages));
    const out: Buffer[] = [];
    for (let i = 1; i <= pages; i++) {
      const png = await renderPageAsImage(doc, i, { scale, canvasImport });
      out.push(Buffer.from(png));
    }
    return out;
  } finally {
    // The proxy itself has no destroy(); the worker is torn down through the
    // loading task that produced it.
    await doc.loadingTask?.destroy().catch(() => undefined);
  }
}
