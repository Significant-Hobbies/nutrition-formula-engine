// GS1 EAN-13 encodes an operator-supplied GTIN, never a generated product ID.
// Check-digit validity does not establish GS1 allocation or ownership.
export const BARCODE_REFERENCE = "https://www.gs1.org/docs/barcodes/GS1_General_Specifications.pdf";
const LEFT = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
const invert = (bits) => [...bits].map((bit) => bit === "1" ? "0" : "1").join("");

export function buildBarcode(value = "") {
  const digits = String(value).trim();
  if (!digits) return { digits: "", valid: false, issue: "Barcode / GTIN to be supplied", source: BARCODE_REFERENCE };
  if (!/^\d{13}$/.test(digits)) return { digits, valid: false, issue: "EAN-13 requires exactly 13 digits", source: BARCODE_REFERENCE };
  const sum = [...digits.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  if ((10 - sum % 10) % 10 !== Number(digits[12])) return { digits, valid: false, issue: "EAN-13 check digit does not match", source: BARCODE_REFERENCE };
  const parity = PARITY[Number(digits[0])];
  const left = [...digits.slice(1, 7)].map((digit, index) => parity[index] === "L" ? LEFT[Number(digit)] : invert(LEFT[Number(digit)]).split("").reverse().join("")).join("");
  const right = [...digits.slice(7)].map((digit) => invert(LEFT[Number(digit)])).join("");
  const bits = `101${left}01010${right}101`;
  return {
    digits, valid: true, bits, source: BARCODE_REFERENCE,
    issue: "Confirm GTIN allocation and verify the printed barcode before production.",
    bars: [...bits].flatMap((bit, index) => bit === "1" ? [{ x: index + 11, height: index < 3 || (index >= 45 && index < 50) || index >= 92 ? 74 : 69 }] : []),
  };
}
