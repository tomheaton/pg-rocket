// Bench suites. Each is `async (driver) => Stats` so `run.ts` can iterate
// (suites × drivers) uniformly. Iteration counts are tuned for local interactive
// use (seconds, not minutes per suite) — bump them for more stable numbers.

import type { Driver } from "./drivers.ts";
import { measure, measureBatch, type Stats } from "./harness.ts";

const USER_ROWS = Number.parseInt(process.env.USER_ROWS ?? "10000", 10);

/** select 1 — the round-trip cost baseline. */
export async function simpleSelect(driver: Driver): Promise<Stats> {
  return measure({
    name: "simple-select",
    driver: driver.name,
    iterations: 5_000,
    warmup: 200,
    fn: () => driver.query("select 1"),
  });
}

/**
 * Single-row OLTP point select with a varying parameter. Targets the prepared-
 * statement cache: drivers that auto-cache should pull ahead after warmup.
 */
export async function preparedLoop(driver: Driver): Promise<Stats> {
  const sql = "select id, email, name, status from users where id = $1";
  let i = 0;
  return measure({
    name: "prepared-loop",
    driver: driver.name,
    iterations: 5_000,
    warmup: 200,
    fn: () => {
      // Round-robin so the parameter varies but the bench is deterministic.
      i = (i + 1) % USER_ROWS;
      return driver.query(sql, [i + 1]);
    },
  });
}

/**
 * N concurrent queries on the same pool via Promise.all. With `pool.max = N`
 * each driver gets one connection per concurrent query; the interesting
 * difference is per-driver dispatch + parsing overhead, not pipelining (the
 * pg-rocket pipeliner lands later).
 */
export async function pipelinedBatch(
  driver: Driver,
  batchSize = 20,
): Promise<Stats> {
  const sql = "select id, email from users where id = $1";
  return measureBatch({
    name: `pipelined-batch (N=${batchSize})`,
    driver: driver.name,
    batches: 200,
    batchSize,
    warmup: 5,
    fn: (i, b) => driver.query(sql, [((b * batchSize + i) % USER_ROWS) + 1]),
  });
}

/**
 * 1k wide rows (20 mixed-type columns). Codec dispatch + row assembly under
 * load — the suite where pg-rocket's flat-array codec lookup and single-buffer
 * design should pay off at scale.
 */
export async function wideRowScan(driver: Driver): Promise<Stats> {
  const sql = "select * from wide_rows order by id limit 1000";
  return measure({
    name: "wide-row-scan",
    driver: driver.name,
    iterations: 200,
    warmup: 5,
    fn: () => driver.query(sql),
  });
}

/**
 * 32 virtual users hitting a pool of 8 with point-selects. Tail latency is
 * the headline; the pool's queue + idle reaping show up here. Driver setup
 * for this suite uses `max=8`, separate from the other (max=1) suites.
 */
export async function poolContention(driver: Driver): Promise<Stats> {
  const sql = "select id, email from users where id = $1";
  const concurrency = 32;
  return measureBatch({
    name: `pool-contention (32u/8c)`,
    driver: driver.name,
    batches: 100,
    batchSize: concurrency,
    warmup: 3,
    fn: (i, b) => driver.query(sql, [((b * concurrency + i) % USER_ROWS) + 1]),
  });
}
