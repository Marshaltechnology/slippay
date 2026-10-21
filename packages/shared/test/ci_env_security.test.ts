import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("CI environment configuration invariants (#182)", () => {
  const root = path.resolve(__dirname, "../../..");
  const workflowPath = path.join(root, ".github/workflows/test.yml");
  const gitignorePath = path.join(root, ".gitignore");
  const required = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DB_URL",
    "JWT_SECRET",
    "RATE_BRL_USDC",
    "API_KEY_PEPPER",
    "CHECKOUT_TOKEN_SECRET",
  ];

  it("does not track a live CI env file", () => {
    expect(fs.existsSync(path.join(root, ".env.local.ci"))).toBe(false);
  });

  it("keeps the workflow as the single source of CI variables", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    expect(workflow).not.toContain("--env-file");
    for (const name of required) {
      expect(workflow).toMatch(new RegExp(`^\\s*${name}:`, "m"));
    }
  });

  it("ignores live env files while allowing checked-in examples", () => {
    const gitignore = fs.readFileSync(gitignorePath, "utf8");
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(gitignore).toMatch(/^!\.env\.\*\.example$/m);
  });
});
