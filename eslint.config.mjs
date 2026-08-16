// QuickHack note: Next.js와 TypeScript 소스에 적용할 ESLint 설정입니다.
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "portfolio/**",
      "release/**",
      // Runtime databases and ACL-protected security artifacts are not source files.
      "database/**",
      ".next/**",
      ".next-client/**",
      ".next-verify-*/**",
      ".tmp/**",
      ".tmp-*/**",
    ],
  },
  ...nextVitals,
  ...nextTs,
  {
    files: ["quickhack_server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/quickhack_server/sales-channel/coupang/api-client",
              importNames: [
                "acknowledgeCoupangOrdersheets",
                "approveCoupangReturnRequest",
                "confirmCoupangReturnReceived",
                "stopCoupangReturnShipment",
              ],
              message:
                "외부 채널 쓰기는 sales-channel write gateway를 통해서만 실행해야 합니다.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "quickhack_server/sales-channel/coupang/write-adapter.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;
