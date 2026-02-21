/**
 * OCR using Tesseract.js (runs in renderer).
 */

import Tesseract from "tesseract.js";

export async function extractTextFromImage(imageSource: string | File): Promise<string> {
  const result = await Tesseract.recognize(imageSource, "eng", {
    logger: () => {},
  });
  return (result.data.text || "").trim();
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
