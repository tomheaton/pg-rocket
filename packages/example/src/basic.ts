import { createClient, type Row, sql } from "pg-rocket";

const URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/pgrocket_bench";

const SCHEMA = "rocket_demo";
const TABLE = sql.id(SCHEMA, "todos");

type Metadata = {
  source: string;
  estimateMinutes: number;
};

type TodoRow = Row & {
  id: number;
  title: string;
  priority: number;
  done: boolean;
  metadata: Metadata;
  created_at: Date;
};

const seedRows: ReadonlyArray<{
  title: string;
  priority: number;
  metadata: Metadata;
}> = [
  {
    title: "Read the public API",
    priority: 2,
    metadata: { source: "demo", estimateMinutes: 10 },
  },
  {
    title: "Wire up demo",
    priority: 3,
    metadata: { source: "demo", estimateMinutes: 20 },
  },
  {
    title: "Try a cursor",
    priority: 1,
    metadata: { source: "demo", estimateMinutes: 5 },
  },
];

async function main(): Promise<void> {
  const db = createClient({
    url: URL,
    applicationName: "pg-rocket-example",
    pool: { max: 2 },
  });

  try {
    console.log(`pg-rocket example`);
    console.log(`url: ${URL}`);

    await resetDemoTable(db);
    await insertSeedRows(db);
    await queryOpenTodos(db);
    await completeOneTodo(db);
    await readWithCursor(db);
  } finally {
    await db.close();
  }
}

async function resetDemoTable(
  db: ReturnType<typeof createClient>,
): Promise<void> {
  await db.sql`create schema if not exists ${sql.id(SCHEMA)}`;
  await db.sql`drop table if exists ${TABLE}`;
  await db.sql`
    create table ${TABLE} (
      id serial primary key,
      title text not null,
      priority int not null,
      done boolean not null default false,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    )
  `;
  console.log(`created ${SCHEMA}.todos`);
}

async function insertSeedRows(
  db: ReturnType<typeof createClient>,
): Promise<void> {
  await db.sql`
    insert into ${TABLE}
    ${sql.values(seedRows, ["title", "priority", "metadata"])}
  `;
  console.log(`inserted ${seedRows.length} todos`);
}

async function queryOpenTodos(
  db: ReturnType<typeof createClient>,
): Promise<void> {
  const filters = [sql`done = ${false}`, sql`priority >= ${2}`];

  const rows = await db.sql<TodoRow>`
    select id, title, priority, done, metadata, created_at
    from ${TABLE}
    where ${sql.join(filters)}
    order by priority desc, id
  `;

  console.log(`open high-priority todos:`);
  for (const row of rows) {
    console.log(formatTodo(row));
  }
}

async function completeOneTodo(
  db: ReturnType<typeof createClient>,
): Promise<void> {
  const completed = await db.transaction(async (tx) => {
    const row = await tx.sqlOne<TodoRow>`
      update ${TABLE}
      set done = true
      where title = ${"Wire up demo"}
      returning id, title, priority, done, metadata, created_at
    `;

    await tx.sql`
      insert into ${TABLE} (title, priority, metadata)
      values (
        ${"Close the pool"},
        ${2},
        ${{
          source: "transaction",
          estimateMinutes: 2,
        }}
      )
    `;

    return row;
  });

  console.log(`completed in a transaction:`);
  console.log(formatTodo(completed));
}

async function readWithCursor(
  db: ReturnType<typeof createClient>,
): Promise<void> {
  console.log(`all todos via cursor batches:`);

  for await (const batch of db.cursor<TodoRow>(
    sql`
      select id, title, priority, done, metadata, created_at
      from ${TABLE}
      order by id
    `,
    2,
  )) {
    console.log(`batch (${batch.length})`);
    for (const row of batch) {
      console.log(formatTodo(row));
    }
  }
}

function formatTodo(row: TodoRow): string {
  const done = row.done ? "x" : " ";
  const createdAt = row.created_at.toISOString();
  return `  [${done}] #${row.id} p${row.priority} ${row.title} (${row.metadata.estimateMinutes}m, ${createdAt})`;
}

main().catch((err) => {
  console.error((err as Error).message);
  console.error("");
  console.error(
    "Start the bundled Postgres with `pnpm db:up`, or set DATABASE_URL.",
  );
  process.exit(1);
});
