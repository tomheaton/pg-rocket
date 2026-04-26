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

// SQLSTATE-class subclasses for the codes people actually want to catch.
// Subclassing is structural here — instanceof checks work; constructor delegation only.

export class UniqueViolation extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "UniqueViolation";
  }
}
export class ForeignKeyViolation extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "ForeignKeyViolation";
  }
}
export class NotNullViolation extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "NotNullViolation";
  }
}
export class CheckViolation extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "CheckViolation";
  }
}
export class SerializationFailure extends PgError {
  constructor(fields: PgErrorFields) {
    super(fields);
    this.name = "SerializationFailure";
  }
}
export class DeadlockDetected extends PgError {
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

const SQLSTATE_SUBCLASS: Readonly<
  Record<string, new (fields: PgErrorFields) => PgError>
> = {
  "23505": UniqueViolation,
  "23503": ForeignKeyViolation,
  "23502": NotNullViolation,
  "23514": CheckViolation,
  "40001": SerializationFailure,
  "40P01": DeadlockDetected,
  "57014": QueryCanceled,
};

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

  const Subclass = SQLSTATE_SUBCLASS[code];
  return Subclass ? new Subclass(fields) : new PgError(fields);
}
