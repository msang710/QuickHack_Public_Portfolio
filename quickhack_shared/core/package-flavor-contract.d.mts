export const PACKAGE_FLAVORS: readonly ["OPERATIONAL", "DEMONSTRATION"];
export type PackageFlavor = (typeof PACKAGE_FLAVORS)[number];

export const POSTGRESQL_MAIN_ROLE_KINDS: readonly [
  "operator",
  "migrator",
  "runtime",
  "backup"
];
export const POSTGRESQL_DEMONSTRATION_ROLE_KINDS: readonly [
  "coupangMock",
  "logenMock"
];
export type PostgresqlConnectionRole =
  | (typeof POSTGRESQL_MAIN_ROLE_KINDS)[number]
  | (typeof POSTGRESQL_DEMONSTRATION_ROLE_KINDS)[number];

export class PackageFlavorContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function assertPackageFlavor(value: unknown): PackageFlavor;
export function postgresqlRoleKindsForFlavor(
  value: unknown
): readonly PostgresqlConnectionRole[];

export type PostgresqlPackageManifest = Readonly<{
  flavor: PackageFlavor;
  roles: readonly Readonly<{
    kind: PostgresqlConnectionRole;
    user: string;
    database: string;
    consumerClass:
      | "LONG_LIVED_APPLICATION"
      | "PRIVILEGED_ONE_SHOT"
      | "DEMONSTRATION_MOCK";
  }>[];
  databases: readonly Readonly<{
    kind: "main" | "coupangMock" | "logenMock";
    name: string;
    ownerRole: "migrator" | "coupangMock" | "logenMock";
  }>[];
}>;

export function createPostgresqlPackageManifest(runtimeConfig: {
  packageFlavor: PackageFlavor;
  database: Record<string, unknown>;
}): PostgresqlPackageManifest;
