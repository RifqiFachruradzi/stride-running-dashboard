// Called by Vercel Cron (see vercel.json) — and safe to hit manually while
// testing. Pulls the latest COROS data, merges it into the committed JSON
// under /data, and pushes a commit to GitHub only when something actually
// changed (so redeploys track real new data, not empty polls).

import { NextRequest, NextResponse } from "next/server";
import { withCorosSession } from "@/lib/coros-mcp-client";
import { addDays, daysBetween, todayInJakarta } from "@/lib/aggregate";
import {
  parseSportRecords,
  parseFitnessAssessment,
  parseTrainingLoad,
  parseBodyHistory,
} from "@/lib/coros-parsers";
import {
  readRuns,
  readFitnessHistory,
  readLoadHistory,
  readBodyHistory,
  mergeRuns,
  mergeFitnessSnapshots,
  mergeLoadSnapshots,
  mergeBodySnapshots,
} from "@/lib/data-store";
import { commitDataFiles } from "@/lib/github";
import { loadActiveProgram, saveDataFiles, saveSyncStatus } from "@/lib/token-store";
import type { SyncResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RUNNING_SPORT_CODES = [100, 101, 102, 103, 104];
// How far back a sync may reach after a long outage.
const MAX_LOOKBACK_DAYS = 120;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Without a secret anyone could trigger syncs (spending COROS quota and
  // pushing commits), so an unset secret is only tolerated outside production.
  if (!secret) return process.env.NODE_ENV !== "production";
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

// The dashboard's status badge reads this; failing to save it must not fail
// the sync itself.
async function recordSyncStatus(result: SyncResult) {
  try {
    await saveSyncStatus(result);
  } catch (err) {
    console.error("Failed to save sync status:", err);
  }
}

// Optional tools may fail on their own (a renamed tool, a COROS hiccup)
// without blocking the runs, which are what the dashboard needs most.
async function optional<T>(
  label: string,
  warnings: string[],
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    console.error(`Sync: ${label} failed:`, err);
    warnings.push(`${label}: ${err.message}`);
    return null;
  }
}

const compact = (day: string) => day.replaceAll("-", "");

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = todayInJakarta();
  const warnings: string[] = [];

  const result: SyncResult = {
    syncedAt: new Date().toISOString(),
    newActivities: 0,
    newSnapshots: 0,
    committed: false,
  };

  try {
    const [existingRuns, existingFitness, existingLoad, existingBody] =
      await Promise.all([
        readRuns(),
        readFitnessHistory(),
        readLoadHistory(),
        readBodyHistory(),
      ]);

    // Reach back to a few days before the newest stored run, so runs logged
    // while syncing was broken are picked up once it works again.
    const lastRunDate = existingRuns.reduce<string | null>(
      (latest, r) => (latest === null || r.date > latest ? r.date : latest),
      null
    );
    const oldest = addDays(today, -MAX_LOOKBACK_DAYS);
    const earliest = (a: string, b: string) => (a < b ? a : b);
    const latest = (a: string, b: string) => (a > b ? a : b);
    const runsStart = latest(
      oldest,
      earliest(lastRunDate ? addDays(lastRunDate, -3) : oldest, addDays(today, -14))
    );
    const bodyDays = Math.min(Math.max(daysBetween(runsStart, today) + 1, 14), 60);

    const raw = await withCorosSession(async (coros) => {
      const sportRecords = await coros.call<string>("querySportRecords", {
        startDate: compact(runsStart),
        endDate: compact(today),
        sportTypeCodes: RUNNING_SPORT_CODES,
        minDistanceKm: null,
        maxDistanceKm: null,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        maxAveragePace: null,
        locationKeyword: null,
        limit: 200,
      });
      const fitness = await optional("queryFitnessAssessmentOverview", warnings, () =>
        coros.call<string>("queryFitnessAssessmentOverview", {})
      );
      const load = await optional("queryTrainingLoadAssessment", warnings, () =>
        coros.call<string>("queryTrainingLoadAssessment", { days: 30 })
      );
      const restingHr = await optional("queryRestingHeartRate", warnings, () =>
        coros.call<string>("queryRestingHeartRate", { days: bodyDays })
      );
      const sleep = await optional("querySleepOverview", warnings, () =>
        coros.call<string>("querySleepOverview", { days: bodyDays })
      );
      const stress = await optional("queryStressLevel", warnings, () =>
        coros.call<string>("queryStressLevel", { days: bodyDays })
      );
      return { sportRecords, fitness, load, restingHr, sleep, stress };
    });

    const runsMerge = mergeRuns(existingRuns, parseSportRecords(raw.sportRecords));
    const fitnessMerge = mergeFitnessSnapshots(
      existingFitness,
      raw.fitness ? [parseFitnessAssessment(raw.fitness, today)] : []
    );
    const loadMerge = mergeLoadSnapshots(
      existingLoad,
      raw.load ? parseTrainingLoad(raw.load) : []
    );
    const bodyMerge = mergeBodySnapshots(
      existingBody,
      parseBodyHistory({
        restingHrRaw: raw.restingHr,
        sleepRaw: raw.sleep,
        stressRaw: raw.stress,
      })
    );

    result.newActivities = runsMerge.addedCount;
    result.newSnapshots =
      fitnessMerge.addedCount + loadMerge.addedCount + bodyMerge.addedCount;
    if (warnings.length > 0) result.warnings = warnings;

    const hasChanges =
      runsMerge.addedCount > 0 ||
      [fitnessMerge, loadMerge, bodyMerge].some(
        (m) => m.addedCount > 0 || m.changedCount > 0
      );

    // The coaching routine can't reach Redis, so it reads the accepted program
    // from the repo; it rides along in the same commit (commitDataFiles skips
    // files that didn't change).
    const activeProgram = await loadActiveProgram();
    const synced: Record<string, unknown> = {
      "runs.json": runsMerge.merged,
      "fitness.json": fitnessMerge.merged,
      "training-load.json": loadMerge.merged,
      "body-condition.json": bodyMerge.merged,
    };
    const files = [
      ...(hasChanges
        ? Object.entries(synced).map(([name, value]) => ({
            path: `data/${name}`,
            content: JSON.stringify(value, null, 2),
          }))
        : []),
      { path: "data/active-program.json", content: JSON.stringify(activeProgram, null, 2) },
    ];
    result.committed = await commitDataFiles(
      files,
      hasChanges
        ? `sync: +${runsMerge.addedCount} run(s), +${result.newSnapshots} snapshot(s) (${today})`
        : `coach: snapshot program aktif (${today})`
    );

    // Show the new data right away instead of after the redeploy. Only once
    // committed: the next sync merges on top of this copy, so it must match
    // the repo.
    if (hasChanges) {
      try {
        await saveDataFiles(synced);
      } catch (err) {
        console.error("Saving synced data to Redis failed:", err);
      }
    }

    await recordSyncStatus(result);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Cron sync failed:", err);
    result.error = err.message;
    if (warnings.length > 0) result.warnings = warnings;
    await recordSyncStatus(result);
    return NextResponse.json(result, { status: 500 });
  }
}
