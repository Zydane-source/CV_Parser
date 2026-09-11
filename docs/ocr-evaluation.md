# Choosing a local OCR engine

The brief asks that OCR options be evaluated rather than the first one taken.
Tesseract was already in the codebase, so this records why it stays rather than
treating incumbency as a decision.

## The constraint that settles most of it

This is a **Node.js/Next.js application deployed to Vercel serverless
functions**. That is not a preference; it is the existing production
architecture the brief says not to rebuild.

| candidate | runtime | viable here? |
|---|---|---|
| **Tesseract.js** | WASM, runs in Node | **yes** — already in the function bundle |
| PaddleOCR | Python + PaddlePaddle | no — needs a Python runtime and ~1 GB of wheels |
| EasyOCR | Python + PyTorch | no — PyTorch alone exceeds Vercel's 250 MB unzipped function limit |
| Cloud OCR APIs (Vision, Textract, Azure) | external | **excluded by the brief** — CV content must not leave the process |

PaddleOCR and EasyOCR are both credible engines and both report better accuracy
than Tesseract on difficult scans, particularly non-Latin scripts. Neither can be
called from a Node serverless function without standing up a separate Python
service — which would be a second deployment, a second runtime and a network hop
carrying CV content between them.

That trade is only worth making if Tesseract is actually failing. It is not.

## Measured, on the benchmark corpus

20 of the 120 CVs are scan-only, with no text layer at all — OCR is the sole
source of text for them.

| | measured |
|---|---|
| all three fields correct on scanned CVs | **20 / 20** |
| OCR time, mean | 1,740 ms |
| OCR time, p50 | 1,736 ms |
| OCR time, max | 3,026 ms |
| credential required | none |
| network required | language data downloaded once, then cached |

OCR is the slowest step in the pipeline by three orders of magnitude — field
extraction is 0.8 ms — but it is bounded, it runs inside Vercel's 60-second
function limit with room to spare, and `OCR_MAX_PAGES` caps the worst case.

A faster or more accurate engine would improve a step that is already scoring
100% on this corpus. That is not where the next accuracy point is.

## What would change the answer

Switching is worth revisiting if any of these become true:

- **Non-Latin CVs.** Tesseract handles Devanagari via `OCR_LANGUAGES=eng+hin`,
  but PaddleOCR is materially better on Indic and CJK scripts. If a meaningful
  share of CVs stop being English, re-run this evaluation.
- **Photographed CVs rather than scans.** Phone-camera images with skew,
  shadows and curl are where Tesseract degrades most and where the
  detection-model engines pull ahead.
- **The worker moves off serverless.** The brief's own fallback architecture —
  a self-hosted processing worker — removes the runtime constraint entirely, and
  a Python OCR service becomes reasonable.

## How to switch without touching the pipeline

`services/ocr/` is behind an interface with two methods:

```ts
extractFromImage(buffer, mimeType, opts): Promise<{ text, confidence, pagesProcessed }>
extractFromScannedPDF(buffer, opts): Promise<{ text, confidence, pagesProcessed }>
```

`OCR_PROVIDER` selects the implementation. Adding a PaddleOCR-backed provider
that talks to a self-hosted service means implementing that interface and
nothing else — the pipeline, extraction and confidence scoring are unaware of
which engine produced the text.

That indirection is the actual insurance here. The decision is reversible, so it
does not need to be perfect.

## Preprocessing

Accuracy on scans owes as much to preprocessing as to the engine.
`services/ocr/tesseract-provider.ts` runs sharp over each page (greyscale,
upscale, sharpen) before Tesseract sees it, and `services/ocr/pdf-render.ts`
rasterises PDF pages at 2× through pdf.js and `@napi-rs/canvas`. Both are local.
