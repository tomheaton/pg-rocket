// Bench harness — timing, distribution math, and pretty-print.
//
// Two flavours:
//
//   measure(name, iterations, warmup, fn)  — sequential per-iteration timings,
//   reports p50 / p95 / p99 / ops-per-sec.
//
//   measureBatch(name, batches, warmup, batchSize, fn) — total-time-per-batch
//   timings (for pipelined / pool-contention work where per-call timing lies).
//
// `process.hrtime.bigint()` for sample collection — same monotonic clock the
// design doc names. We don't include warmup samples in the report.

export interface Stats {
  readonly name: string;
  readonly driver: string;
  readonly iterations: number;
  readonly p50Ns: number;
  readonly p95Ns: number;
  readonly p99Ns: number;
  readonly meanNs: number;
  readonly opsPerSec: number;
  /** Wall-clock seconds for the measurement phase. */
  readonly wallSecs: number;
}

export async function measure(args: {
  name: string;
  driver: string;
  iterations: number;
  warmup: number;
  fn: (i: number) => Promise<unknown>;
}): Promise<Stats> {
  for (let i = 0; i < args.warmup; i++) await args.fn(i);

  const samples = new BigInt64Array(args.iterations);
  const tStart = process.hrtime.bigint();
  for (let i = 0; i < args.iterations; i++) {
    const s = process.hrtime.bigint();
    await args.fn(i);
    samples[i] = process.hrtime.bigint() - s;
  }
  const tWall = process.hrtime.bigint() - tStart;

  return summarise(args.name, args.driver, samples, tWall);
}

/**
 * `batches` total batches, each containing `batchSize` parallel ops via
 * `Promise.all`. Per-batch wall time is the sample. Suited to pipelined-batch
 * and pool-contention workloads where the interesting metric is throughput
 * across concurrent calls, not the latency of any single call.
 */
export async function measureBatch(args: {
  name: string;
  driver: string;
  batches: number;
  batchSize: number;
  warmup: number;
  fn: (i: number, batchIndex: number) => Promise<unknown>;
}): Promise<Stats> {
  for (let b = 0; b < args.warmup; b++) {
    const ps = new Array(args.batchSize);
    for (let i = 0; i < args.batchSize; i++) ps[i] = args.fn(i, b);
    await Promise.all(ps);
  }

  const samples = new BigInt64Array(args.batches);
  const tStart = process.hrtime.bigint();
  for (let b = 0; b < args.batches; b++) {
    const s = process.hrtime.bigint();
    const ps = new Array(args.batchSize);
    for (let i = 0; i < args.batchSize; i++) ps[i] = args.fn(i, b);
    await Promise.all(ps);
    samples[b] = process.hrtime.bigint() - s;
  }
  const tWall = process.hrtime.bigint() - tStart;

  // Ops/sec is normalised by batch size so the number is comparable to the
  // sequential `measure` flavour.
  const stats = summarise(args.name, args.driver, samples, tWall);
  return {
    ...stats,
    opsPerSec: Math.round((args.batches * args.batchSize) / stats.wallSecs),
  };
}

function summarise(
  name: string,
  driver: string,
  samples: BigInt64Array,
  tWall: bigint,
): Stats {
  const sorted = new BigInt64Array(samples);
  sortBig(sorted);
  const pick = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return Number(sorted[idx] as bigint);
  };
  let sum = 0n;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i] as bigint;
  const meanNs = Number(sum / BigInt(sorted.length));
  const wallSecs = Number(tWall) / 1e9;
  return {
    name,
    driver,
    iterations: sorted.length,
    p50Ns: pick(0.5),
    p95Ns: pick(0.95),
    p99Ns: pick(0.99),
    meanNs,
    opsPerSec: Math.round(sorted.length / wallSecs),
    wallSecs,
  };
}

function sortBig(arr: BigInt64Array): void {
  // Plain Array.sort doesn't work on BigInt64Array. Pull through a regular
  // array; sample counts are small enough that the round-trip is fine.
  const out = Array.from(arr);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 0; i < arr.length; i++) arr[i] = out[i] as bigint;
}

// ────────────────────────────────────────────────────────────────────────
// Pretty-print

const NSEC_PER_USEC = 1_000;
const NSEC_PER_MSEC = 1_000_000;

function formatDuration(ns: number): string {
  if (ns < NSEC_PER_USEC) return `${ns.toFixed(0)}ns`;
  if (ns < NSEC_PER_MSEC) return `${(ns / NSEC_PER_USEC).toFixed(2)}µs`;
  return `${(ns / NSEC_PER_MSEC).toFixed(2)}ms`;
}

function formatOps(ops: number): string {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M/s`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)}k/s`;
  return `${ops}/s`;
}

/**
 * Print a row of stats per driver, side-by-side. The first row's metric is
 * taken as the baseline so the others' columns include a relative-speed annotation.
 */
export function printGroup(suiteName: string, runs: readonly Stats[]): void {
  console.log(
    `\n── ${suiteName} ${"─".repeat(Math.max(0, 60 - suiteName.length))}`,
  );
  if (runs.length === 0) {
    console.log("  (no runs)");
    return;
  }
  const driverWidth = Math.max(8, ...runs.map((r) => r.driver.length));
  console.log(
    `  ${"driver".padEnd(driverWidth)}  ${"p50".padStart(9)}  ${"p95".padStart(9)}  ${"p99".padStart(9)}  ${"mean".padStart(9)}  ${"ops".padStart(10)}  rel`,
  );

  const baseline = runs[0] as Stats;
  for (const r of runs) {
    const rel =
      r === baseline ? "1.00x" : `${(baseline.meanNs / r.meanNs).toFixed(2)}x`;
    console.log(
      `  ${r.driver.padEnd(driverWidth)}  ${formatDuration(r.p50Ns).padStart(9)}  ${formatDuration(r.p95Ns).padStart(9)}  ${formatDuration(r.p99Ns).padStart(9)}  ${formatDuration(r.meanNs).padStart(9)}  ${formatOps(r.opsPerSec).padStart(10)}  ${rel.padStart(5)}`,
    );
  }
}
