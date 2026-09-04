export type MessageShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : T[Key] extends Readonly<Record<string, unknown>>
      ? MessageShape<T[Key]>
      : never;
};

export type MessageArguments = Readonly<Record<string, string | number | Date>>;
