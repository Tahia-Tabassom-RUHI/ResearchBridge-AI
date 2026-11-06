import tables from "./python-unicode.json";

export const UNICODE_VERSION = tables.unicode_version;
type Range = number[];
function inRanges(character: string, ranges: Range[]): boolean {
  const point = character.codePointAt(0)!;
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const [start, end] = ranges[mid]! as [number, number];
    if (point < start) high = mid - 1;
    else if (point > end) low = mid + 1;
    else return true;
  }
  return false;
}
function characterClass(ranges: Range[]): string {
  return ranges.map(([start, end]) => `\\u{${start!.toString(16)}}` + (start === end ? "" : `-\\u{${end!.toString(16)}}`)).join("");
}
const pythonSpace = new RegExp(`[${characterClass(tables.whitespace)}]+`, "u");
const pythonNumbers = new RegExp(`(?<![${characterClass(tables.word)}])[${characterClass(tables.decimal)}]+(?:[.,][${characterClass(tables.decimal)}]+)*%?`, "gu");
const casefold = tables.casefold as Record<string, string>;
export const length = (text: string): number => Array.from(text).length;
export const asciiWords = (text: string): string[] => text.split(/[ \t\n\r\f\v]+/).filter(Boolean);
export const pythonWords = (text: string): string[] => text.split(pythonSpace).filter(Boolean);
export const normalize = (text: string): string => asciiWords(text.replace(/[A-Z]/g, c => c.toLowerCase())).join(" ");
export const normalizeV1 = (text: string): string => pythonWords(Array.from(text, char => casefold[String(char.codePointAt(0)!)] ?? char).join("")).join(" ");
export const hasLetter = (word: string): boolean => Array.from(word).some(char => inRanges(char, tables.letter));
export const hasNonAsciiNumber = (text: string): boolean => Array.from(text).some(char => !/[0-9]/.test(char) && inRanges(char, tables.number));
export const numericStrings = (text: string): Set<string> => new Set(text.match(/[0-9]+(?:[.,][0-9]+)*%?/g) ?? []);
export const numericStringsV1 = (text: string): Set<string> => new Set(text.match(pythonNumbers) ?? []);
