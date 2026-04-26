// Bench orchestrator.
//
// Runs each suite against each driver and prints the comparative table. No
// JSON archiving, no subprocess isolation, no matrix — this is the local-loop
// "did my change move the needle" tool.
//
// The driver order is fixed (pg-rocket first) so its row appears as the
// baseline (1.00x) and the others' rel columns read as "speed multiple".

import {
  type Driver,
  type DriverSetup,
  PgDriver,
  PgRocketDriver,
  PostgresJsDriver,
} from "./drivers.ts";
import { printGroup, type Stats } from "./harness.ts";
import {
  pipelinedBatch,
  poolContention,
  preparedLoop,
  simpleSelect,
  wideRowScan,
} from "./suites.ts";

const URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/pgrocket_bench";

interface SuiteSpec {
  readonly title: string;
  /** Pool size each driver is set up with. */
  readonly poolMax: number;
  readonly run: (driver: Driver) => Promise<Stats>;
}

const SUITES: SuiteSpec[] = [
  { title: "simple-select", poolMax: 1, run: simpleSelect },
  { title: "prepared-loop", poolMax: 1, run: preparedLoop },
  { title: "wide-row-scan", poolMax: 1, run: wideRowScan },
  {
    title: "pipelined-batch (N=20)",
    poolMax: 20,
    run: (d) => pipelinedBatch(d, 20),
  },
  { title: "pool-contention (32u/8c)", poolMax: 8, run: poolContention },
];

async function main(): Promise<void> {
  console.log(`pg-rocket bench`);
  console.log(`url: ${URL}`);
  console.log(`node: ${process.version}`);
  console.log(`platform: ${process.platform} ${process.arch}\n`);

  for (const suite of SUITES) {
    const setup: DriverSetup = { url: URL, max: suite.poolMax };
    const results: Stats[] = [];
    for (const driver of buildDrivers()) {
      try {
        await driver.setup(setup);
        // `process.stdout.write` gives a "running…" line with no newline so the
        // result row replaces it on the next print.
        process.stdout.write(
          `  ${suite.title.padEnd(28)} ${driver.name.padEnd(10)} … `,
        );
        const t0 = Date.now();
        const stats = await suite.run(driver);
        process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
        results.push(stats);
      } catch (err) {
        process.stdout.write(`failed\n`);
        console.error(`    ${(err as Error).message}`);
      } finally {
        await driver.teardown().catch(() => {
          /* best-effort */
        });
      }
    }
    printGroup(suite.title, results);
  }
}

function buildDrivers(): readonly Driver[] {
  // pg-rocket first so it anchors the relative-speed column.
  return [new PgRocketDriver(), new PostgresJsDriver(), new PgDriver()];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
