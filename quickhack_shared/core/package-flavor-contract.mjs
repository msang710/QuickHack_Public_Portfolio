export const PACKAGE_FLAVORS = Object.freeze([
  "OPERATIONAL",
  "DEMONSTRATION",
]);

export const POSTGRESQL_MAIN_ROLE_KINDS = Object.freeze([
  "operator",
  "migrator",
  "runtime",
  "backup",
]);

export const POSTGRESQL_DEMONSTRATION_ROLE_KINDS = Object.freeze([
  "coupangMock",
  "logenMock",
]);

const PACKAGE_FLAVOR_SET = new Set(PACKAGE_FLAVORS);

export class PackageFlavorContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PackageFlavorContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackageFlavorContractError(code, message);
}

export function assertPackageFlavor(value) {
  const flavor = String(value ?? "").trim().toUpperCase();
  if (!PACKAGE_FLAVOR_SET.has(flavor)) {
    fail("PACKAGE_FLAVOR_INVALID", "지원하지 않는 QuickHack package flavor입니다.");
  }
  return flavor;
}

export function postgresqlRoleKindsForFlavor(value) {
  const flavor = assertPackageFlavor(value);
  return flavor === "DEMONSTRATION"
    ? Object.freeze([
        ...POSTGRESQL_MAIN_ROLE_KINDS,
        ...POSTGRESQL_DEMONSTRATION_ROLE_KINDS,
      ])
    : POSTGRESQL_MAIN_ROLE_KINDS;
}

function identifier(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(normalized)) {
    fail(
      "PACKAGE_POSTGRESQL_MANIFEST_INVALID",
      `QuickHack PostgreSQL manifest의 ${label} 식별자가 올바르지 않습니다.`
    );
  }
  return normalized;
}

function freezeEntry(value) {
  return Object.freeze(value);
}

export function createPostgresqlPackageManifest(runtimeConfig) {
  const flavor = assertPackageFlavor(runtimeConfig?.packageFlavor);
  const database = runtimeConfig?.database;
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    fail(
      "PACKAGE_POSTGRESQL_MANIFEST_INVALID",
      "QuickHack PostgreSQL manifest database 설정이 필요합니다."
    );
  }

  const mainDatabase = identifier(database.name, "database.name");
  const roles = [
    freezeEntry({
      kind: "operator",
      user: "quickhack_operator",
      database: "postgres",
      consumerClass: "PRIVILEGED_ONE_SHOT",
    }),
    freezeEntry({
      kind: "migrator",
      user: identifier(database.migratorUser, "database.migratorUser"),
      database: mainDatabase,
      consumerClass: "PRIVILEGED_ONE_SHOT",
    }),
    freezeEntry({
      kind: "runtime",
      user: identifier(database.runtimeUser, "database.runtimeUser"),
      database: mainDatabase,
      consumerClass: "LONG_LIVED_APPLICATION",
    }),
    freezeEntry({
      kind: "backup",
      user: "quickhack_backup",
      database: mainDatabase,
      consumerClass: "LONG_LIVED_APPLICATION",
    }),
  ];
  const databases = [
    freezeEntry({
      kind: "main",
      name: mainDatabase,
      ownerRole: "migrator",
    }),
  ];

  if (flavor === "DEMONSTRATION") {
    const coupangMockDatabase = identifier(
      database.coupangMockName,
      "database.coupangMockName"
    );
    const logenMockDatabase = identifier(
      database.logenMockName,
      "database.logenMockName"
    );
    roles.push(
      freezeEntry({
        kind: "coupangMock",
        user: identifier(database.coupangMockUser, "database.coupangMockUser"),
        database: coupangMockDatabase,
        consumerClass: "DEMONSTRATION_MOCK",
      }),
      freezeEntry({
        kind: "logenMock",
        user: identifier(database.logenMockUser, "database.logenMockUser"),
        database: logenMockDatabase,
        consumerClass: "DEMONSTRATION_MOCK",
      })
    );
    databases.push(
      freezeEntry({
        kind: "coupangMock",
        name: coupangMockDatabase,
        ownerRole: "coupangMock",
      }),
      freezeEntry({
        kind: "logenMock",
        name: logenMockDatabase,
        ownerRole: "logenMock",
      })
    );
  }

  const roleKinds = roles.map((role) => role.kind);
  if (new Set(roleKinds).size !== roleKinds.length) {
    fail(
      "PACKAGE_POSTGRESQL_MANIFEST_INVALID",
      "QuickHack PostgreSQL role manifest에 중복 역할이 있습니다."
    );
  }
  const roleUsers = roles.map((role) => role.user);
  if (new Set(roleUsers).size !== roleUsers.length) {
    fail(
      "PACKAGE_POSTGRESQL_MANIFEST_INVALID",
      "QuickHack PostgreSQL role manifest에 공유 login role이 있습니다."
    );
  }
  const databaseNames = databases.map((item) => item.name);
  if (new Set(databaseNames).size !== databaseNames.length) {
    fail(
      "PACKAGE_POSTGRESQL_MANIFEST_INVALID",
      "QuickHack PostgreSQL database manifest에 중복 database가 있습니다."
    );
  }

  return Object.freeze({
    flavor,
    roles: Object.freeze(roles),
    databases: Object.freeze(databases),
  });
}
