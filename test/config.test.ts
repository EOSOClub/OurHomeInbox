import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadDotEnv } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ourhomeinbox-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes config.yml into the temp folder and returns an environment pointing at it. */
function setup(yaml: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = join(dir, "config.yml");
  writeFileSync(path, yaml);
  return { OURHOMEINBOX_CONFIG: path, ...extraEnv };
}

const PROTON = `
mailboxes:
  - name: Proton bills
    provider: proton-bridge
    username: me@proton.me
    password_env: PROTON_BRIDGE_PASSWORD
    folder: Folders/Bills
`;

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("fills in the proton-bridge defaults and the password from the environment", () => {
    const config = loadConfig(setup(PROTON, { PROTON_BRIDGE_PASSWORD: "bridge-pass" }));
    expect(config).toEqual({
      logLevel: "info",
      mailboxes: [
        {
          name: "Proton bills",
          provider: "proton-bridge",
          host: "protonmail-bridge",
          port: 143,
          tls: false,
          username: "me@proton.me",
          password: "bridge-pass",
          folder: "Folders/Bills",
        },
      ],
    });
  });

  it("keeps connection values that config.yml sets", () => {
    const yaml = `${PROTON}    host: bridge.local\n    port: 1143\n    tls: true\n`;
    const [mailbox] = loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })).mailboxes;
    expect(mailbox).toMatchObject({ host: "bridge.local", port: 1143, tls: true });
  });

  it("uses INBOX when no folder is given", () => {
    const yaml = PROTON.replace("    folder: Folders/Bills\n", "");
    expect(loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })).mailboxes[0]?.folder).toBe("INBOX");
  });

  it("says how to create config.yml when it is missing", () => {
    const problems = problemsOf(() => loadConfig({ OURHOMEINBOX_CONFIG: join(dir, "nope.yml") }));
    expect(problems[0]).toContain("Copy config.example.yml to config.yml");
  });

  it("names the .env line and the mailbox when a password is missing", () => {
    const problems = problemsOf(() => loadConfig(setup(PROTON)));
    expect(problems).toEqual([
      'PROTON_BRIDGE_PASSWORD is empty or missing in .env (the password for mailbox "Proton bills").',
    ]);
  });

  it("treats an empty password, as copied from .env.example, as missing", () => {
    const problems = problemsOf(() => loadConfig(setup(PROTON, { PROTON_BRIDGE_PASSWORD: "" })));
    expect(problems[0]).toContain("PROTON_BRIDGE_PASSWORD is empty or missing");
  });

  it("rejects a misspelt setting instead of ignoring it", () => {
    const problems = problemsOf(() =>
      loadConfig(setup(`${PROTON}    fodler: Bills\n`, { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("mailboxes[0]");
    expect(problems[0]).toContain("fodler");
  });

  it("rejects two mailboxes with the same name", () => {
    const mailbox = PROTON.replace("mailboxes:\n", "");
    const problems = problemsOf(() =>
      loadConfig(setup(`mailboxes:\n${mailbox}${mailbox}`, { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems[0]).toContain("each mailbox needs its own name");
  });

  it("rejects a file with no mailboxes", () => {
    const problems = problemsOf(() => loadConfig(setup("log_level: info\n")));
    expect(problems[0]).toContain("mailboxes");
  });

  it("accepts the docker section that deploy.sh reads", () => {
    const yaml = `${PROTON}docker:\n  network: ourhome_net\n`;
    expect(loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })).mailboxes).toHaveLength(1);
  });

  it("rejects a misspelt setting in the docker section", () => {
    const problems = problemsOf(() =>
      loadConfig(setup(`${PROTON}docker:\n  netwrok: ourhome_net\n`, { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems[0]).toContain("docker");
    expect(problems[0]).toContain("netwrok");
  });

  it("accepts config.example.yml as shipped", () => {
    const config = loadConfig({ OURHOMEINBOX_CONFIG: "config.example.yml", PROTON_BRIDGE_PASSWORD: "x" });
    expect(config.mailboxes[0]).toMatchObject({ provider: "proton-bridge", folder: "Folders/Bills" });
  });

  it("reports broken YAML as a settings problem", () => {
    const problems = problemsOf(() => loadConfig(setup("mailboxes: [\n")));
    expect(problems[0]).toContain("is not valid YAML");
  });
});

describe("loadDotEnv", () => {
  it("adds values from the file without overriding ones already set", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "PROTON_BRIDGE_PASSWORD=from-file\nOTHER=from-file\n");
    const env: NodeJS.ProcessEnv = { PROTON_BRIDGE_PASSWORD: "from-docker" };
    loadDotEnv(path, env);
    expect(env).toEqual({ PROTON_BRIDGE_PASSWORD: "from-docker", OTHER: "from-file" });
  });

  it("does nothing when there is no .env file", () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(join(dir, "missing.env"), env);
    expect(env).toEqual({});
  });
});
