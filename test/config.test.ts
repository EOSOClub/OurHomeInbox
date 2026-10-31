import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadDotEnv, mailboxSlug, updateConfigFile } from "../src/config.js";

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
    imap:
      host: protonmail-bridge
      port: 143
      security: none
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
  it("reads the IMAP connection as written and the password from the environment", () => {
    const config = loadConfig(setup(PROTON, { PROTON_BRIDGE_PASSWORD: "bridge-pass" }));
    expect(config).toEqual({
      logLevel: "info",
      mailboxes: [
        {
          name: "Proton bills",
          provider: "proton-bridge",
          imap: {
            host: "protonmail-bridge",
            port: 143,
            security: "none",
            username: "me@proton.me",
            passwordEnv: "PROTON_BRIDGE_PASSWORD",
            password: "bridge-pass",
          },
          folder: "Folders/Bills",
        },
      ],
      web: { port: 8080 },
      capture: { everyMinutes: 15 },
      docker: null,
    });
  });

  it("reads the web and capture settings when given", () => {
    const yaml = `${PROTON}web:\n  port: 9000\ncapture:\n  every_minutes: 5\n`;
    const config = loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" }));
    expect(config.web).toEqual({ port: 9000 });
    expect(config.capture).toEqual({ everyMinutes: 5 });
  });

  it("rejects a docker bind that is not an address", () => {
    const problems = problemsOf(() =>
      loadConfig(setup(`${PROTON}docker:\n  bind: everywhere\n`, { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems[0]).toContain("docker.bind");
  });

  it.each(["none", "starttls", "tls"])("accepts security: %s", (security) => {
    const yaml = PROTON.replace("security: none", `security: ${security}`);
    expect(loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })).mailboxes[0]?.imap.security).toBe(security);
  });

  it.each([
    ["STARTTLS", "starttls"],
    ["None", "none"],
    [" TLS ", "tls"],
  ])("accepts security: %s in any capitalization", (written, expected) => {
    const yaml = PROTON.replace("security: none", `security: "${written}"`);
    expect(loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })).mailboxes[0]?.imap.security).toBe(expected);
  });

  it("rejects a security mode it does not know", () => {
    const yaml = PROTON.replace("security: none", "security: ssl");
    const problems = problemsOf(() => loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })));
    expect(problems[0]).toContain("mailboxes[0].imap.security");
  });

  it.each(["host", "port", "security", "username", "password_env"])(
    "requires imap %s: nothing about the connection is implied",
    (key) => {
      const yaml = PROTON.split("\n").filter((line) => !line.trim().startsWith(`${key}:`)).join("\n");
      const problems = problemsOf(() => loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`mailboxes[0].imap.${key}`);
    },
  );

  it("rejects connection settings outside the imap block", () => {
    const problems = problemsOf(() =>
      loadConfig(setup(`${PROTON}    host: elsewhere\n`, { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems[0]).toContain("host");
  });

  it("uses INBOX when no folder is given", () => {
    const yaml = PROTON.replace("    folder: Folders/Bills\n", "");
    expect(loadConfig(setup(yaml, { PROTON_BRIDGE_PASSWORD: "x" })).mailboxes[0]?.folder).toBe("INBOX");
  });

  it("says how to create config.yml when it is missing", () => {
    const problems = problemsOf(() => loadConfig({ OURHOMEINBOX_CONFIG: join(dir, "nope.yml") }));
    expect(problems[0]).toContain("Copy config.example.yml to config.yml");
  });

  // Mailboxes are copied into the database once, where a missing password is
  // shown on the Settings page and can be added there; it no longer stops start.
  it("leaves a mailbox's password empty when its .env line is missing or empty, naming the line", () => {
    for (const env of [{}, { PROTON_BRIDGE_PASSWORD: "" }] as Array<Record<string, string>>) {
      const [mailbox] = loadConfig(setup(PROTON, env)).mailboxes;
      expect(mailbox?.imap).toMatchObject({ passwordEnv: "PROTON_BRIDGE_PASSWORD", password: "" });
    }
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

  it("rejects mailbox names that would share a data folder", () => {
    const second = PROTON.replace("mailboxes:\n", "").replace("name: Proton bills", "name: proton-bills!");
    const problems = problemsOf(() =>
      loadConfig(setup(`${PROTON}${second}`, { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems[0]).toContain("own data folder");
  });

  it("rejects a mailbox name with no letters or numbers", () => {
    const problems = problemsOf(() =>
      loadConfig(setup(PROTON.replace("name: Proton bills", 'name: "!!!"'), { PROTON_BRIDGE_PASSWORD: "x" })),
    );
    expect(problems[0]).toContain("at least one letter or number");
  });

  it("accepts a file with no mailboxes: they are added on the web page", () => {
    expect(loadConfig(setup("log_level: info\n")).mailboxes).toEqual([]);
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
    expect(config.mailboxes[0]).toMatchObject({
      provider: "proton-bridge",
      imap: { host: "protonmail-bridge", port: 143, security: "none" },
      folder: "Folders/Bills",
    });
  });

  it("reports broken YAML as a settings problem", () => {
    const problems = problemsOf(() => loadConfig(setup("mailboxes: [\n")));
    expect(problems[0]).toContain("is not valid YAML");
  });
});

describe("updateConfigFile", () => {
  const FILE = `# OurHomeInbox settings.
log_level: info # how much the log says

capture:
  # How often mail is read.
  every_minutes: 15
${PROTON}`;

  it("changes only what was asked, keeping comments and layout, after copying the old file", () => {
    const env = setup(FILE, { PROTON_BRIDGE_PASSWORD: "x" });
    const backup = join(dir, "config.yml.bak");
    updateConfigFile(env.OURHOMEINBOX_CONFIG!, { logLevel: "debug", captureEveryMinutes: 5 }, backup);
    const text = readFileSync(env.OURHOMEINBOX_CONFIG!, "utf8");
    expect(text).toBe(FILE.replace("log_level: info", "log_level: debug").replace("every_minutes: 15", "every_minutes: 5"));
    expect(readFileSync(backup, "utf8")).toBe(FILE);
    expect(loadConfig(env)).toMatchObject({ logLevel: "debug", capture: { everyMinutes: 5 } });
  });

  it("adds a section the file does not have yet", () => {
    const env = setup(PROTON);
    updateConfigFile(env.OURHOMEINBOX_CONFIG!, { captureEveryMinutes: 30 }, join(dir, "bak"));
    expect(loadConfig(env).capture.everyMinutes).toBe(30);
    expect(readFileSync(env.OURHOMEINBOX_CONFIG!, "utf8")).toContain("name: Proton bills");
  });

  it("writes nothing, and makes no copy, when a change would make the file wrong or changes nothing", () => {
    const env = setup(FILE);
    const backup = join(dir, "config.yml.bak");
    expect(problemsOf(() => updateConfigFile(env.OURHOMEINBOX_CONFIG!, { captureEveryMinutes: 0 }, backup))[0]).toContain("capture.every_minutes");
    updateConfigFile(env.OURHOMEINBOX_CONFIG!, { logLevel: "info", captureEveryMinutes: 15 }, backup);
    expect(readFileSync(env.OURHOMEINBOX_CONFIG!, "utf8")).toBe(FILE);
    expect(() => readFileSync(backup)).toThrow();
  });

  it("refuses to change a file that is already broken", () => {
    const env = setup("log_level: [\n");
    expect(problemsOf(() => updateConfigFile(env.OURHOMEINBOX_CONFIG!, { logLevel: "warn" }, join(dir, "bak")))[0]).toContain("is not valid YAML");
    expect(readFileSync(env.OURHOMEINBOX_CONFIG!, "utf8")).toBe("log_level: [\n");
  });
});

describe("mailboxSlug", () => {
  it.each([
    ["Proton bills", "proton-bills"],
    ["  Électricité & Gas!  ", "electricite-gas"],
    ["a/../b", "a-b"],
    ["!!!", ""],
  ])("%j becomes %j", (name, expected) => {
    expect(mailboxSlug(name)).toBe(expected);
  });
});

describe(".env.example", () => {
  // The repo is public: the template must never carry a real secret.
  it("ships every secret empty", () => {
    const filled = readFileSync(".env.example", "utf8")
      .split(/\r?\n/)
      .filter((line) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(line));
    expect(filled).toEqual([]);
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
