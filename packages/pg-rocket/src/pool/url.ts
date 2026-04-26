// Connection-string parser, libpq-compatible.
//
// Hand-rolled (rather than via WHATWG URL) for two reasons:
//   * The WHATWG parser doesn't expose `password` cleanly for `postgres://` URLs.
//   * Cold-import budget — pulling in URL is fine for Node, but we want this
//     usable in environments where the URL parser is less available too.
//
// Supported parameter names match libpq:
//   sslmode             → tls (disable / prefer / require)
//   application_name    → applicationName
//   connect_timeout     → connectTimeoutMs (×1000)
//   user, password, host, port, dbname     — also accepted on the URL itself
// Unknown parameters are passed through as `serverParameters` for forwarding
// in StartupMessage; Postgres ignores those it doesn't recognise.

import type { TlsMode } from "../connection/index.js";

export interface ParsedConnectionString {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | undefined;
  readonly database: string;
  readonly tls: TlsMode | undefined;
  readonly applicationName: string | undefined;
  readonly connectTimeoutMs: number | undefined;
  /** Other key=value pairs the user supplied; forwarded verbatim. */
  readonly serverParameters: Readonly<Record<string, string>>;
}

const DEFAULT_PORT = 5432;

export function parseConnectionString(url: string): ParsedConnectionString {
  const match = /^(postgres(?:ql)?):\/\//.exec(url);
  if (!match) {
    throw new TypeError(
      `pg-rocket: connection string must start with postgres:// or postgresql://`,
    );
  }
  let rest = url.slice((match[0] as string).length);

  // userinfo[@]host[:port]/database[?params]
  let userInfo = "";
  const atIdx = lastIndexOfBeforeSlashOrQuery(rest, "@");
  if (atIdx >= 0) {
    userInfo = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }

  let path = "";
  let query = "";
  const slashIdx = rest.indexOf("/");
  const queryIdx = rest.indexOf("?");
  if (slashIdx >= 0 && (queryIdx < 0 || slashIdx < queryIdx)) {
    path = rest.slice(slashIdx + 1);
    rest = rest.slice(0, slashIdx);
  }
  const pQueryIdx = path.indexOf("?");
  if (pQueryIdx >= 0) {
    query = path.slice(pQueryIdx + 1);
    path = path.slice(0, pQueryIdx);
  } else if (queryIdx >= 0 && slashIdx < 0) {
    query = rest.slice(queryIdx + 1);
    rest = rest.slice(0, queryIdx);
  }

  // host:port — port is optional. IPv6 addresses arrive in `[…]`; not handled in v0.
  let host = "localhost";
  let port = DEFAULT_PORT;
  if (rest.length > 0) {
    const colonIdx = rest.lastIndexOf(":");
    if (colonIdx >= 0) {
      host = decodeURIComponent(rest.slice(0, colonIdx));
      const portStr = rest.slice(colonIdx + 1);
      const parsed = Number.parseInt(portStr, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new TypeError(
          `pg-rocket: invalid port "${portStr}" in connection string`,
        );
      }
      port = parsed;
    } else {
      host = decodeURIComponent(rest);
    }
  }

  // user[:password]
  let user = "";
  let password: string | undefined;
  if (userInfo.length > 0) {
    const colonIdx = userInfo.indexOf(":");
    if (colonIdx >= 0) {
      user = decodeURIComponent(userInfo.slice(0, colonIdx));
      password = decodeURIComponent(userInfo.slice(colonIdx + 1));
    } else {
      user = decodeURIComponent(userInfo);
    }
  }

  const database = decodeURIComponent(path);

  // Query parameters
  let tls: TlsMode | undefined;
  let applicationName: string | undefined;
  let connectTimeoutMs: number | undefined;
  const serverParameters: Record<string, string> = {};

  if (query.length > 0) {
    for (const pair of query.split("&")) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
      const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1));
      switch (key) {
        case "sslmode":
          tls = parseSslMode(value);
          break;
        case "application_name":
          applicationName = value;
          break;
        case "connect_timeout": {
          const seconds = Number.parseInt(value, 10);
          if (Number.isFinite(seconds) && seconds >= 0) {
            connectTimeoutMs = seconds * 1000;
          }
          break;
        }
        default:
          serverParameters[key] = value;
          break;
      }
    }
  }

  return {
    host,
    port,
    user,
    password,
    database,
    tls,
    applicationName,
    connectTimeoutMs,
    serverParameters,
  };
}

function parseSslMode(value: string): TlsMode {
  switch (value) {
    case "disable":
    case "prefer":
    case "require":
      return value;
    default:
      // verify-ca / verify-full deferred to v0.x; for now accept and downgrade
      // to require so we don't surprise users on RDS / Cloud SQL with strict CA setups.
      if (value === "verify-ca" || value === "verify-full") return "require";
      throw new TypeError(`pg-rocket: unsupported sslmode "${value}"`);
  }
}

// "@" can appear inside a query string (rare, but real). Find the last `@`
// before any `/` or `?` so we don't pick one up from the path.
function lastIndexOfBeforeSlashOrQuery(s: string, ch: string): number {
  let limit = s.length;
  const slash = s.indexOf("/");
  if (slash >= 0) limit = Math.min(limit, slash);
  const q = s.indexOf("?");
  if (q >= 0) limit = Math.min(limit, q);
  const search = s.slice(0, limit);
  return search.lastIndexOf(ch);
}
