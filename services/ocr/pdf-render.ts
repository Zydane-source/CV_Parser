/**
 * Render PDF pages to PNG buffers (for OCR of scanned PDFs) using pdf.js + @napi-rs/canvas.
 */
type RenderCanvasImport = NonNullable<Parameters<typeof import("unpdf").renderPageAsImage>[2]>["canvas"];
type FactoryCanvasImport = Parameters<typeof import("unpdf").createIsomorphicCanvasFactory>[0];

// unpdf's types reference the `canvas` package; @napi-rs/canvas is API-compatible for rendering.
const canvasImport = () => import("@napi-rs/canvas");
const napiCanvas = canvasImport as unknown as RenderCanvasImport;
const napiCanvasForFactory = canvasImport as unknown as FactoryCanvasImport;

export async function renderPdfPagesToImages(pdf: Buffer, maxPages: number, scale = 2): Promise<Buffer[]> {
  const { getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } = await import("unpdf");
  // pdf.js transfers (detaches) the byte buffer to its worker, so always hand it a copy.
  const data = new Uint8Array(pdf);
  // The document needs a canvas factory too: embedded images in scanned pages are
  // painted through the document's own factory, not the output canvas.
  const canvasFactory = await createIsomorphicCanvasFactory(napiCanvasForFactory);
  const doc = await getDocumentProxy(data, { canvasFactory });
  try {
    const pages = Math.min(doc.numPages, Math.max(1, maxPages));
    const out: Buffer[] = [];
    for (let i = 1; i <= pages; i++) {
      const png = await renderPageAsImage(doc, i, { scale, canvas: napiCanvas });
      out.push(Buffer.from(png));
    }
    return out;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
