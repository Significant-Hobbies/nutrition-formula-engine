import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readSheet } from "read-excel-file/browser";
import { createWorker, OEM, PSM } from "tesseract.js";

import { normalizeMatrix, normalizeText } from "./input-normalizer.js";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);
const TEXT_EXTENSIONS = new Set(["tsv", "csv", "txt", "json", "md"]);

let ocrWorkerPromise = null;

function fileExtension(file) {
  return file.name.toLowerCase().split(".").pop() || "";
}

function progressLabel(message) {
  const label = String(message.status || "Reading image").replace(/_/g, " ");
  const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}${progress}`;
}

async function getOcrWorker(onProgress) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng", OEM.LSTM_ONLY, {
      logger: (message) => onProgress(progressLabel(message)),
      errorHandler: (error) => console.error("Browser OCR failed", error),
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });
      return worker;
    });
  }
  return ocrWorkerPromise;
}

async function recognizeImage(image, onProgress) {
  onProgress("Loading browser OCR…");
  const worker = await getOcrWorker(onProgress);
  const result = await worker.recognize(image);
  const text = result.data.text.trim();
  if (!text) throw new Error("OCR did not recover any text from this image.");
  return text;
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

async function renderPdfPage(page) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function ingestPdf(file, onProgress) {
  onProgress("Reading PDF in this browser…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data: bytes }).promise;
  if (pdf.numPages > MAX_PDF_PAGES) {
    throw new Error(`This workspace reads up to ${MAX_PDF_PAGES} PDF pages; this file has ${pdf.numPages}.`);
  }

  const pageTexts = [];
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress(`Reading PDF page ${pageNumber} of ${pdf.numPages}…`);
    const page = await pdf.getPage(pageNumber);
    pages.push(page);
    const content = await page.getTextContent();
    pageTexts.push(pdfPageText(content.items));
  }
  const embeddedText = pageTexts.join("\n").trim();
  if (embeddedText) {
    try {
      return { ...normalizeText(embeddedText, "PDF embedded text"), rawText: embeddedText };
    } catch {
      // A scanned or layout-heavy PDF falls through to page OCR.
    }
  }

  const ocrTexts = [];
  for (let index = 0; index < pages.length; index += 1) {
    onProgress(`Rendering PDF page ${index + 1} of ${pages.length} for OCR…`);
    const canvas = await renderPdfPage(pages[index]);
    ocrTexts.push(await recognizeImage(canvas, onProgress));
  }
  const rawText = ocrTexts.join("\n");
  return { ...normalizeText(rawText, "PDF OCR"), rawText };
}

async function ingestSpreadsheet(file, onProgress) {
  onProgress("Reading spreadsheet in this browser…");
  const matrix = await readSheet(file);
  return { ...normalizeMatrix(matrix, "XLSX spreadsheet"), rawText: "" };
}

export async function ingestFile(file, onProgress = () => {}) {
  if (!file) throw new Error("Choose a file or paste a formula.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("The input must be 12 MB or smaller.");
  const extension = fileExtension(file);
  if (extension === "xlsx") return ingestSpreadsheet(file, onProgress);
  if (extension === "pdf" || file.type === "application/pdf") return ingestPdf(file, onProgress);
  if (IMAGE_TYPES.has(file.type) || ["png", "jpg", "jpeg", "webp", "bmp"].includes(extension)) {
    const rawText = await recognizeImage(file, onProgress);
    return { ...normalizeText(rawText, "image OCR"), rawText };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) {
    const rawText = await file.text();
    return { ...normalizeText(rawText, extension === "json" ? "JSON" : "text file"), rawText };
  }
  throw new Error(
    "That file type is not supported yet. Use pasted text, TSV, CSV, TXT, JSON, XLSX, PNG, JPEG, WebP, BMP, or PDF.",
  );
}

export function ingestText(text) {
  return { ...normalizeText(text), rawText: text };
}
