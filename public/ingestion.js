import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readSheet } from "read-excel-file/browser";
import { createWorker, OEM, PSM } from "tesseract.js";

import { normalizeMatrix, normalizeText, normalizePages } from "./input-normalizer.js";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);
const TEXT_EXTENSIONS = new Set(["tsv", "csv", "txt", "json", "md"]);

let ocrWorkerPromise = null;
let ocrProgress = () => {};

function fileExtension(file) {
  return file.name.toLowerCase().split(".").pop() || "";
}

function progressLabel(message) {
  const label = String(message.status || "Reading image").replace(/_/g, " ");
  const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}${progress}`;
}

function abortable(promise, signal, cleanup = () => {}) {
  if (!signal) return promise;
  if (signal.aborted) { cleanup(); return Promise.reject(signal.reason || new Error("Reading cancelled.")); }
  let onAbort;
  return Promise.race([promise, new Promise((_, reject) => {
    onAbort = () => { cleanup(); reject(signal.reason || new Error("Reading cancelled.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  })]).finally(() => signal.removeEventListener("abort", onAbort));
}

function resetOcrWorker(promise) {
  if (ocrWorkerPromise === promise) {
    ocrWorkerPromise = null;
    ocrProgress = () => {};
  }
  // A cancelled initialization may settle after its replacement is ready.
  // Terminate that attempt only, and never clear the replacement's cache.
  if (promise?.worker) void promise.worker.terminate().catch(() => {});
  else void promise?.then((worker) => worker.terminate()).catch(() => {});
}

async function getOcrWorker(onProgress, signal) {
  ocrProgress = onProgress;
  if (!ocrWorkerPromise) {
    let attempt;
    attempt = createWorker("eng", OEM.LSTM_ONLY, {
      logger: (message) => { if (ocrWorkerPromise === attempt) ocrProgress(progressLabel(message)); },
      errorHandler: (error) => console.error("Browser OCR failed", error),
    }).then(async (worker) => {
      attempt.worker = worker;
      if (ocrWorkerPromise !== attempt) {
        await worker.terminate().catch(() => {});
        throw new Error("Reading cancelled.");
      }
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
      } catch (error) {
        await worker.terminate().catch(() => {});
        throw error;
      }
      return worker;
    }).catch((error) => {
      if (ocrWorkerPromise === attempt) ocrWorkerPromise = null;
      throw error;
    });
    ocrWorkerPromise = attempt;
  }
  const attempt = ocrWorkerPromise;
  return abortable(attempt, signal, () => resetOcrWorker(attempt));
}

async function recognizeImage(image, onProgress, signal) {
  signal?.throwIfAborted();
  onProgress("Loading browser OCR…");
  const worker = await getOcrWorker(onProgress, signal);
  const attempt = ocrWorkerPromise;
  try {
    signal?.throwIfAborted();
    const result = await abortable(worker.recognize(image), signal, () => resetOcrWorker(attempt));
    const text = result.data.text;
    if (!text.trim()) throw new Error("OCR did not recover any text from this image.");
    return { text, ocr: { engine: "Tesseract.js 7 / LSTM", language: "eng", scope: "image", confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : null } };
  } catch (error) {
    if (!signal?.aborted) resetOcrWorker(attempt);
    throw error;
  }
}

function pdfPageText(items) {
  const lines = new Map();
  for (const item of items) {
    if (!item.str?.trim() || !item.transform) continue;
    const y = Math.round(item.transform[5] / 4) * 4;
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ x: item.transform[4], text: item.str.trim() });
  }
  return [...lines.entries()]
    .sort(([yA], [yB]) => yB - yA)
    .map(([, pieces]) => pieces.sort((a, b) => a.x - b.x).map((piece) => piece.text).join(" "))
    .join("\n");
}

async function renderPdfPage(page, signal) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  const render = page.render({ canvasContext: context, viewport });
  await abortable(render.promise, signal, () => render.cancel());
  return canvas;
}

async function ingestPdf(file, onProgress, options) {
  onProgress("Reading PDF in this browser…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  options.signal?.throwIfAborted();
  const loading = getDocument({ data: bytes });
  let pdf;
  let destroyed = false;
  const destroy = () => {
    if (!destroyed) { destroyed = true; void loading.destroy().catch(() => {}); }
  };
  try {
    pdf = await abortable(loading.promise, options.signal, destroy);
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(`This workspace reads up to ${MAX_PDF_PAGES} PDF pages; this file has ${pdf.numPages}.`);
    }

    const pageTexts = [];
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress(`Reading PDF page ${pageNumber} of ${pdf.numPages}…`);
      options.signal?.throwIfAborted();
      const page = await abortable(pdf.getPage(pageNumber), options.signal, destroy);
      pages.push(page);
      const content = await abortable(page.getTextContent(), options.signal, destroy);
      const text = pdfPageText(content.items);
      // Only a page with no drawing operators is provably empty. A scanned page
      // or unrecognized nonblank content must still go through OCR.
      const empty = !text && (await abortable(page.getOperatorList(), options.signal, destroy)).fnArray.length === 0;
      pageTexts.push({ text, empty });
    }
    const embeddedText = pageTexts.map((page) => page.text).join("\n").trim();
    if (embeddedText && pageTexts.every((page) => page.text.trim() || page.empty)) {
      try {
        return normalizePages(pageTexts, "PDF embedded text", options);
      } catch {
        // A scanned or layout-heavy PDF falls through to page OCR.
      }
    }

    const ocrTexts = [];
    for (let index = 0; index < pages.length; index += 1) {
      if (pageTexts[index].empty) {
        ocrTexts.push({ text: "" });
        continue;
      }
      onProgress(`Rendering PDF page ${index + 1} of ${pages.length} for OCR…`);
      const canvas = await renderPdfPage(pages[index], options.signal);
      try {
        const recognized = await recognizeImage(canvas, onProgress, options.signal);
        recognized.ocr.scope = "page";
        ocrTexts.push(recognized);
      } catch {
        options.signal?.throwIfAborted();
        throw new Error(`Could not recover text from nonblank PDF page ${index + 1}. Check this page or enter its rows manually.`);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return normalizePages(ocrTexts, "PDF OCR", options);
  } finally {
    // PDF.js owns page/render resources; release on success, error and abort.
    destroy();
  }
}

async function ingestSpreadsheet(file, onProgress, options) {
  onProgress("Reading spreadsheet in this browser…");
  const matrix = await readSheet(file, { trim: false, parseNumber: (value) => value });
  return { ...normalizeMatrix(matrix, "XLSX spreadsheet", { ...options, worksheet: 1 }), rawText: "" };
}

export async function ingestFile(file, onProgress = () => {}, options = {}) {
  options.signal?.throwIfAborted();
  if (!file) throw new Error("Choose a file or paste a formula.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("The input must be 12 MB or smaller.");
  const extension = fileExtension(file);
  if (extension === "xlsx") return ingestSpreadsheet(file, onProgress, options);
  if (extension === "pdf" || file.type === "application/pdf") return ingestPdf(file, onProgress, options);
  if (IMAGE_TYPES.has(file.type) || ["png", "jpg", "jpeg", "webp", "bmp"].includes(extension)) {
    const recognized = await recognizeImage(file, onProgress, options.signal);
    const rawText = recognized.text;
    const sourceRows = rawText.split(/\r\n|\r|\n/).map(() => ({ ocr: recognized.ocr }));
    return { ...normalizeText(rawText, "image OCR", { ...options, sourceRows }), rawText };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) {
    const rawText = await file.text();
    return { ...normalizeText(rawText, extension === "json" ? "JSON" : "text file", options), rawText };
  }
  throw new Error(
    "That file type is not supported yet. Use pasted text, TSV, CSV, TXT, JSON, XLSX, PNG, JPEG, WebP, BMP, or PDF.",
  );
}

export function ingestText(text) {
  return { ...normalizeText(text), rawText: text };
}
