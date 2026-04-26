// Public package entry. v0 surface is intentionally tiny:
//   - createClient() (factory; not implemented yet)
//   - sql tag        (not implemented yet)
//   - errors         (not implemented yet)
//
// The protocol layer is reachable via the `pg-rocket/protocol` subpath for
// embedders implementing alternative transports.

export {} from "./protocol/index.js";
