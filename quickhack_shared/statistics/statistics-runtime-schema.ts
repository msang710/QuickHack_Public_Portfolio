export class StatisticsRuntimeSchemaError extends Error {
  readonly path: string;
  readonly expected: string;

  constructor(path: string, expected: string) {
    super(`${path} must be ${expected}.`);
    this.name = "StatisticsRuntimeSchemaError";
    this.path = path;
    this.expected = expected;
  }
}

export type RuntimeSchema<T> = {
  readonly expected: string;
  readonly validate: (value: unknown, path: string) => void;
  readonly output?: T;
};

type RuntimeSchemaOutput<Schema> =
  Schema extends RuntimeSchema<infer Output> ? Output : never;

type RuntimeObjectShape<Value extends object> = {
  [Key in keyof Value]-?: RuntimeSchema<Value[Key]>;
};

function runtimeSchema<T>(
  expected: string,
  validate: (value: unknown, path: string) => boolean
): RuntimeSchema<T> {
  return {
    expected,
    validate(value, path) {
      if (!validate(value, path)) {
        throw new StatisticsRuntimeSchemaError(path, expected);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const stringSchema = runtimeSchema<string>(
  "a string",
  (value) => typeof value === "string"
);

export const finiteNumberSchema = runtimeSchema<number>(
  "a finite number",
  (value) => typeof value === "number" && Number.isFinite(value)
);

export const booleanSchema = runtimeSchema<boolean>(
  "a boolean",
  (value) => typeof value === "boolean"
);

export function nullableSchema<T>(
  schema: RuntimeSchema<T>
): RuntimeSchema<T | null> {
  return {
    expected: `${schema.expected} or null`,
    validate(value, path) {
      if (value !== null) {
        schema.validate(value, path);
      }
    },
  };
}

export function optionalSchema<T>(
  schema: RuntimeSchema<T>
): RuntimeSchema<T | undefined> {
  return {
    expected: `${schema.expected} or undefined`,
    validate(value, path) {
      if (value !== undefined) {
        schema.validate(value, path);
      }
    },
  };
}

type RuntimeLiteral = string | number | boolean | null;

export function oneOfSchema<
  const Values extends readonly RuntimeLiteral[],
>(...values: Values): RuntimeSchema<Values[number]> {
  const allowed = new Set<RuntimeLiteral>(values);
  const expected = values.map((value) => JSON.stringify(value)).join(" or ");

  return runtimeSchema<Values[number]>(
    expected || "one of the supported literal values",
    (value) => allowed.has(value as RuntimeLiteral)
  );
}

export function arraySchema<T>(
  itemSchema: RuntimeSchema<T>
): RuntimeSchema<T[]> {
  return {
    expected: `an array of ${itemSchema.expected}`,
    validate(value, path) {
      if (!Array.isArray(value)) {
        throw new StatisticsRuntimeSchemaError(
          path,
          `an array of ${itemSchema.expected}`
        );
      }

      value.forEach((entry, index) => {
        itemSchema.validate(entry, `${path}[${index}]`);
      });
    },
  };
}

export function recordSchema<T>(
  valueSchema: RuntimeSchema<T>
): RuntimeSchema<Record<string, T>> {
  return {
    expected: `an object with ${valueSchema.expected} values`,
    validate(value, path) {
      if (!isRecord(value)) {
        throw new StatisticsRuntimeSchemaError(
          path,
          `an object with ${valueSchema.expected} values`
        );
      }

      for (const [key, child] of Object.entries(value)) {
        valueSchema.validate(child, `${path}.${key}`);
      }
    },
  };
}

export function objectSchema<Value extends object>(
  shape: RuntimeObjectShape<Value>
): RuntimeSchema<Value> {
  return {
    expected: "an object with the required fields",
    validate(value, path) {
      if (!isRecord(value)) {
        throw new StatisticsRuntimeSchemaError(
          path,
          "an object with the required fields"
        );
      }

      for (const [key, schema] of Object.entries(shape) as Array<
        [string, RuntimeSchema<unknown>]
      >) {
        schema.validate(value[key], `${path}.${key}`);
      }
    },
  };
}

export function unionSchema<
  const Schemas extends readonly RuntimeSchema<unknown>[],
>(
  ...schemas: Schemas
): RuntimeSchema<RuntimeSchemaOutput<Schemas[number]>> {
  const expected = schemas.map((schema) => schema.expected).join(" or ");

  return {
    expected,
    validate(value, path) {
      for (const schema of schemas) {
        try {
          schema.validate(value, path);
          return;
        } catch (error) {
          if (!(error instanceof StatisticsRuntimeSchemaError)) {
            throw error;
          }
        }
      }

      throw new StatisticsRuntimeSchemaError(path, expected);
    },
  };
}

export function assertRuntimeSchema<T>(
  schema: RuntimeSchema<T>,
  value: unknown,
  path = "value"
): asserts value is T {
  schema.validate(value, path);
}
