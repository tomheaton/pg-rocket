# pg-rocket example

A small runnable demo of the public `pg-rocket` API.

```sh
pnpm db:up
pnpm example
```

By default it connects to the same local Postgres used by the bench suite:

```sh
postgres://postgres:postgres@localhost:5433/pgrocket_bench
```

Point it at another database with `DATABASE_URL`:

```sh
DATABASE_URL=postgres://you@localhost:5432/your_db pnpm example
```

The demo creates and replaces a `rocket_demo.todos` table, then shows:

- `createClient`
- `db.sql` and `db.sqlOne`
- SQL composition with `sql.id`, `sql.join`, and `sql.values`
- callback transactions with `db.transaction`
- batched reads with `db.cursor`
