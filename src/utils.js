import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function cleanText(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

export function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

export function calculateDiscountRate(originalPrice, currentPrice) {
  const original = toNumber(originalPrice);
  const current = toNumber(currentPrice);
  if (original === null || current === null || original <= 0 || current > original) return null;
  return Math.round(((original - current) / original) * 100);
}

export function formatWon(value) {
  const number = toNumber(value);
  return number === null ? '확인 불가' : `${Math.round(number).toLocaleString('ko-KR')}원`;
}

export function formatPercent(value) {
  const number = toNumber(value);
  return number === null ? '확인 불가' : `${Math.round(number)}%`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatKoreanTime(iso, timezone = 'Asia/Seoul') {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(iso ? new Date(iso) : new Date());
}

export function errorToString(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function uniqueBy(items, keyFn) {
  const output = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key !== null && key !== undefined) output.set(key, item);
  }
  return [...output.values()];
}

export function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}
