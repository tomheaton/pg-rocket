// Error hierarchy.
//
// Two roots, intentionally distinct so callers can distinguish "the server
// rejected my query" from "the connection is broken":
//
//   PgError           — fields parsed from a backend ErrorResponse / NoticeResponse.
//   ConnectionError   — transport, auth, and protocol-state failures.
//
// SQLSTATE-class subclasses cover the codes people actually `catch` on, so
// `instanceof UniqueViolation` works without the user memorising 23505.

import { readErrorFields } from "./protocol/body.js";
import { FieldCode } from "./protocol/messages.js";

export interface PgErrorFields {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
  readonly position?: number | undefined;
  readonly internalPosition?: number | undefined;
  readonly internalQuery?: string | undefined;
  readonly where?: string | undefined;
  readonly schema?: string | undefined;
  readonly table?: string | undefined;
  readonly column?: string | undefined;
  readonly dataType?: string | undefined;
  readonly constraint?: string | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly routine?: string | undefined;
}

export class PgError extends Error {
  readonly code: string;
  readonly severity: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly position: number | undefined;
  readonly internalPosition: number | undefined;
  readonly internalQuery: string | undefined;
  readonly where: string | undefined;
  readonly schema: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly dataType: string | undefined;
  readonly constraint: string | undefined;
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly routine: string | undefined;

  constructor(fields: PgErrorFields) {
    super(fields.message);
    this.name = "PgError";
    this.code = fields.code;
    this.severity = fields.severity;
    this.detail = fields.detail;
    this.hint = fields.hint;
    this.position = fields.position;
    this.internalPosition = fields.internalPosition;
    this.internalQuery = fields.internalQuery;
    this.where = fields.where;
    this.schema = fields.schema;
    this.table = fields.table;
    this.column = fields.column;
    this.dataType = fields.dataType;
    this.constraint = fields.constraint;
    this.file = fields.file;
    this.line = fields.line;
    this.routine = fields.routine;
  }
}

// SQLSTATE-class hierarchy. Two layers:
//
//   IntegrityError, TransactionError, PgSyntaxError, InsufficientResources are
//   the *class* level — `instanceof IntegrityError` matches any 23xxx, even
//   ones we don't ship a specific subclass for. Useful when callers want to
//   catch "anything in the integrity family" without listing every code.
//
//   UniqueViolation / ForeignKeyViolation / SerializationFailure / etc. are
//   the *specific* level — exact SQLSTATE matches.
//
// Subclasses delegate to PgError's constructor and only override `name`.

export class IntegrityError extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "IntegrityError";
  }
}
export class UniqueViolation extends IntegrityError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "UniqueViolation";
  }
}
export class ForeignKeyViolation extends IntegrityError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "ForeignKeyViolation";
  }
}
export class NotNullViolation extends IntegrityError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "NotNullViolation";
  }
}
export class CheckViolation extends IntegrityError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "CheckViolation";
  }
}
export class ExclusionViolation extends IntegrityError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "ExclusionViolation";
  }
}

export class TransactionError extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "TransactionError";
  }
}
export class SerializationFailure extends TransactionError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "SerializationFailure";
  }
}
export class DeadlockDetected extends TransactionError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "DeadlockDetected";
  }
}

export class QueryCanceled extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "QueryCanceled";
  }
}

export class InsufficientResources extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "InsufficientResources";
  }
}

export class PgSyntaxError extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "PgSyntaxError";
  }
}
export class UndefinedColumn extends PgSyntaxError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "UndefinedColumn";
  }
}
export class UndefinedTable extends PgSyntaxError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "UndefinedTable";
  }
}
export class UndefinedFunction extends PgSyntaxError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "UndefinedFunction";
  }
}

// Specific-code map. Looked up first — exact match wins over class fallback.
const SQLSTATE_SUBCLASS: Readonly<
  Record<string, new (fields: PgErrorFields) => PgError>
> = {
  // 23xxx — integrity_constraint_violation
  "23505": UniqueViolation,
  "23503": ForeignKeyViolation,
  "23502": NotNullViolation,
  "23514": CheckViolation,
  "23P01": ExclusionViolation,
  // 40xxx — transaction_rollback
  "40001": SerializationFailure,
  "40P01": DeadlockDetected,
  // 42xxx — syntax_error_or_access_rule_violation
  "42703": UndefinedColumn,
  "42P01": UndefinedTable,
  "42883": UndefinedFunction,
  // 57014 — query_canceled
  "57014": QueryCanceled,
};

// SQLSTATE class fallback by 2-character prefix. Used when the specific code
// isn't in the map above — `23xyz` (any unknown integrity violation) still
// surfaces as IntegrityError so generic catches work.
function classForSqlstate(
  code: string,
): (new (fields: PgErrorFields) => PgError) | undefined {
  if (code.length < 2) return undefined;
  const cls = code.slice(0, 2);
  switch (cls) {
    case "23":
      return IntegrityError;
    case "40":
      return TransactionError;
    case "42":
      return PgSyntaxError;
    case "53":
      return InsufficientResources;
    default:
      return undefined;
  }
}

// Connection-level errors are a separate hierarchy from server-side PgError so that
// callers can distinguish "the query failed" from "the connection itself broke".

export class ConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

export class AuthenticationError extends ConnectionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

export class ProtocolError extends ConnectionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

/**
 * Raised when a `db.with({ timeout })` deadline fires, or any other
 * client-side timeout (connection acquire, idle handshake) elapses. Lives
 * under ConnectionError because there's no server-side state involved.
 */
export class TimeoutError extends ConnectionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TimeoutError";
  }
}

// Codec failures are their own root — they're neither server-side errors
// (the server didn't reject anything) nor connection-level (the transport
// is fine). They mean "we couldn't translate between Postgres bytes and a
// JS value", which is independent of both directions of failure.

export class CodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodecError";
  }
}

export class EncodingError extends CodecError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EncodingError";
  }
}

export class DecodingError extends CodecError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecodingError";
  }
}

/**
 * Decode a backend ErrorResponse / NoticeResponse body into structured fields.
 * Picks the most specific PgError subclass when the SQLSTATE matches one we ship.
 */
export function decodeErrorResponse(
  buf: Uint8Array,
  offset: number,
  length: number,
): PgError {
  let code = "";
  let severity = "";
  let message = "";
  let detail: string | undefined;
  let hint: string | undefined;
  let position: number | undefined;
  let internalPosition: number | undefined;
  let internalQuery: string | undefined;
  let where: string | undefined;
  let schema: string | undefined;
  let table: string | undefined;
  let column: string | undefined;
  let dataType: string | undefined;
  let constraint: string | undefined;
  let file: string | undefined;
  let line: number | undefined;
  let routine: string | undefined;

  for (const f of readErrorFields(buf, offset, length)) {
    switch (f.code) {
      case FieldCode.Code:
        code = f.value;
        break;
      case FieldCode.SeverityNonLocal:
        severity = f.value;
        break;
      case FieldCode.Severity:
        // Localised severity — only adopt if the non-localised one wasn't sent.
        if (severity === "") severity = f.value;
        break;
      case FieldCode.Message:
        message = f.value;
        break;
      case FieldCode.Detail:
        detail = f.value;
        break;
      case FieldCode.Hint:
        hint = f.value;
        break;
      case FieldCode.Position:
        position = Number.parseInt(f.value, 10);
        break;
      case FieldCode.InternalPosition:
        internalPosition = Number.parseInt(f.value, 10);
        break;
      case FieldCode.InternalQuery:
        internalQuery = f.value;
        break;
      case FieldCode.Where:
        where = f.value;
        break;
      case FieldCode.Schema:
        schema = f.value;
        break;
      case FieldCode.Table:
        table = f.value;
        break;
      case FieldCode.Column:
        column = f.value;
        break;
      case FieldCode.DataType:
        dataType = f.value;
        break;
      case FieldCode.Constraint:
        constraint = f.value;
        break;
      case FieldCode.File:
        file = f.value;
        break;
      case FieldCode.Line:
        line = Number.parseInt(f.value, 10);
        break;
      case FieldCode.Routine:
        routine = f.value;
        break;
      default:
        // Unknown field codes are tolerated — the protocol is forward-compatible.
        break;
    }
  }

  const fields: PgErrorFields = {
    code,
    severity,
    message,
    detail,
    hint,
    position,
    internalPosition,
    internalQuery,
    where,
    schema,
    table,
    column,
    dataType,
    constraint,
    file,
    line,
    routine,
  };

  const specific = SQLSTATE_SUBCLASS[code];
  if (specific !== undefined) return new specific(fields);
  const cls = classForSqlstate(code);
  if (cls !== undefined) return new cls(fields);
  return new PgError(fields);
}
