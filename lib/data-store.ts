// Reads the dashboard's committed JSON data and merges in freshly-fetched
// COROS data, deduping so syncs can run often without producing duplicate
// entries or needless commits. Files a sync just wrote are read from Redis
// until the deployment carries them (see saveDataFiles).

import { readFile } from "fs/promises";
import path from "path";
import { cache } from "react";
import { isStorageConfigured, loadDataFile } from "./token-store";
import type {
  RunActivity,
  FitnessSnapshot,
  LoadSnapshot,
  BodySnapshot,
} from "./types";
import { parseRecommendation, type Recommendation } from "./coach";

const DATA_DIR = path.join(process.cwd(), "data");

export interface RecommendationFile {
  recommendation: Recommendation | null;
  /** Validation errors when the AI-written file is malformed */
  errors: string[];
}

export async function readRecommendation(): Promise<RecommendationFile> {
  let raw: string;
  try {
    raw = await readFile(path.join(DATA_DIR, "recommendation.json"), "utf-8");
  } catch {
    return { recommendation: null, errors: [] }; // routine hasn't run yet
  }
  try {
    const parsed = parseRecommendation(JSON.parse(raw));
    return parsed.ok
      ? { recommendation: parsed.value, errors: [] }
      : { recommendation: null, errors: parsed.errors };
  } catch {
    return { recommendation: null, errors: ["recommendation.json bukan JSON yang valid"] };
  }
}

// The synced files; others (recommendation, active program) only change
// through their own commits.
export const SYNCED_FILES = ["runs.json", "fitness.json", "training-load.json", "body-condition.json"];

// Several components read the same file per request; fetch it once.
const loadFile = cache(async (filename: string): Promise<unknown> => {
  if (isStorageConfigured() && SYNCED_FILES.includes(filename)) {
    try {
      const fresh = await loadDataFile(filename);
      if (fresh) return fresh;
    } catch (err) {
      console.error(`Reading ${filename} from Redis failed, using the deployed copy:`, err);
    }
  }
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, filename), "utf-8"));
  } catch {
    return undefined;
  }
});

async function readJson<T>(filename: string, fallback: T): Promise<T> {
  const value = await loadFile(filename);
  // A copy, since callers may sort the arrays in place.
  return value === undefined ? fallback : (structuredClone(value) as T);
}

export async function readRuns(): Promise<RunActivity[]> {
  return readJson<RunActivity[]>("runs.json", []);
}

export async function readFitnessHistory(): Promise<FitnessSnapshot[]> {
  return readJson<FitnessSnapshot[]>("fitness.json", []);
}

export async function readLoadHistory(): Promise<LoadSnapshot[]> {
  return readJson<LoadSnapshot[]>("training-load.json", []);
}

export async function readBodyHistory(): Promise<BodySnapshot[]> {
  return readJson<BodySnapshot[]>("body-condition.json", []);
}

/** Merge new runs in by labelId, newest first. Returns { merged, addedCount }. */
export function mergeRuns(
  existing: RunActivity[],
  incoming: RunActivity[]
): { merged: RunActivity[]; addedCount: number } {
  const byId = new Map(existing.map((r) => [r.labelId, r]));
  let added = 0;
  for (const run of incoming) {
    if (!byId.has(run.labelId)) added++;
    byId.set(run.labelId, run); // incoming wins on conflict (fresher data)
  }
  const merged = Array.from(byId.values()).sort(
    (a, b) => b.startTimestamp - a.startTimestamp
  );
  return { merged, addedCount: added };
}

/**
 * Merge daily snapshots (fitness/load/body) by date, one entry per day.
 * `changedCount` also counts days whose values changed (e.g. a sleep score
 * that COROS only filled in after the previous sync), so those get committed.
 */
function mergeByDate<T extends { date: string }>(
  existing: T[],
  incoming: T[],
  combine: (old: T, next: T) => T = (_old, next) => next
): { merged: T[]; addedCount: number; changedCount: number } {
  const byDate = new Map(existing.map((s) => [s.date, s]));
  let added = 0;
  let changed = 0;
  for (const snap of incoming) {
    const old = byDate.get(snap.date);
    const next = old ? combine(old, snap) : snap;
    if (!old) added++;
    else if (JSON.stringify(old) !== JSON.stringify(next)) changed++;
    byDate.set(snap.date, next);
  }
  const merged = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  return { merged, addedCount: added, changedCount: changed };
}

export const mergeFitnessSnapshots = (existing: FitnessSnapshot[], incoming: FitnessSnapshot[]) =>
  mergeByDate(existing, incoming);
export const mergeLoadSnapshots = (existing: LoadSnapshot[], incoming: LoadSnapshot[]) =>
  mergeByDate(existing, incoming);
// Body fields come from three separate tools; one failing must not wipe the
// values another sync already stored for that day.
export const mergeBodySnapshots = (existing: BodySnapshot[], incoming: BodySnapshot[]) =>
  mergeByDate(existing, incoming, (old, next) => ({
    date: next.date,
    restingHeartRate: next.restingHeartRate ?? old.restingHeartRate,
    sleepScore: next.sleepScore ?? old.sleepScore,
    sleepDurationMinutes: next.sleepDurationMinutes ?? old.sleepDurationMinutes,
    stressLevel: next.stressLevel ?? old.stressLevel,
  }));
