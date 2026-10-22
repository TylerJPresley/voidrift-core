/**
 * Secret-mask seam test (core-blueprint.md §6.8, §10.10).
 *
 * Proves the single shared detector masks every §10.10 category at the leaves,
 * leaves negatives (UUIDs, plain hashes/base64) untouched, yields a stable
 * marker for the same secret, and preserves the surrounding structure. The
 * seam's invocation on the live ask path (PendingApproval + PERMISSION_REQUESTED)
 * is proved in `guardian.section9.test.ts`; the memory-provider path in
 * `memory.section6.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { maskSecrets, maskValue, containsSecret, isSecretHeader } from "./secret-mask.js";

describe("§10.10 — secret-mask detector", () => {
  it("masks a bearer authorization header, hiding the value not the structure", () => {
    const args = { command: 'curl -H "Authorization: Bearer sk-liv' + 'e-DEADBEEFCAFEBABE01"' };
    const out = maskSecrets(args) as { command: string };
    expect(out.command).not.toContain("sk-liv" + "e-DEADBEEFCAFEBABE01");
    expect(out.command).toContain("Authorization");
  });

  it("masks every §10.10 category", () => {
    const samples: Record<string, string> = {
      aws: "AKIAIO" + "SFODNN7EXAMPLE",
      openai: "sk-abc" + "defghijklmnopqrstuvwx",
      github: "ghp_01" + "23456789abcdefghijABCDEFGHIJ0123",
      jwt: "eyJhbG" + "ciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abc123def456",
      env: "API_TOKEN=supersecretvalue123",
      pem: "-----B" + "EGIN RSA PRIVATE KEY-----\nMIIBOgIBAAI= \n-----END RSA PRIVATE KEY-----",
    };
    const out = maskValue(samples) as Record<string, string>;
    expect(out.aws).not.toContain("AKIAIO" + "SFODNN7EXAMPLE");
    expect(out.openai).not.toContain("sk-abc" + "defghijklmnopqrstuvwx");
    expect(out.github).not.toContain("ghp_01" + "23456789abcdefghijABCDEFGHIJ0123");
    expect(out.jwt).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out.env).not.toContain("supersecretvalue123");
    expect(out.env).toContain("API_TOKEN"); // structure (name) preserved
    expect(out.pem).not.toContain("MIIBOgIBAAI=");
  });

  it("leaves negative samples (UUID, plain hash, base64) untouched", () => {
    const negatives = {
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      b64: "aGVsbG8gd29ybGQgdGhpcyBpcyBwbGFpbiB0ZXh0",
      plain: "the quick brown fox",
    };
    expect(maskValue(negatives)).toEqual(negatives);
  });

  it("yields a stable marker for the same secret (correlation survives)", () => {
    const a = maskValue("sk-abc" + "defghijklmnopqrstuvwx") as string;
    const b = maskValue("sk-abc" + "defghijklmnopqrstuvwx") as string;
    expect(a).toEqual(b);
    expect(a).not.toContain("sk-abc" + "defghijklmnopqrstuvwx");
  });

  it("preserves non-secret keys/values and nested structure", () => {
    const args = { path: "/etc/x", count: 1, nested: { ok: true, label: "plain" } };
    expect(maskValue(args)).toEqual(args);
  });

  it("returns a deep copy, never a live reference", () => {
    const args = { nested: { k: 1 } };
    const out = maskValue(args) as typeof args;
    expect(out).not.toBe(args);
    expect(out.nested).not.toBe(args.nested);
    expect(out).toEqual(args);
  });

  it("containsSecret reuses the one detector: true for a secret, false for plain text", () => {
    expect(containsSecret("Bearer sk-abc" + "def0123456789abcdef")).toBe(true);
    expect(containsSecret("just a label")).toBe(false);
  });

  it("isSecretHeader treats Authorization as always secret and flags secret-looking values (§8.4)", () => {
    expect(isSecretHeader("Authorization", "anything")).toBe(true);
    expect(isSecretHeader("X-Api-Key", "sk-abc" + "def0123456789abcdef")).toBe(true);
    expect(isSecretHeader("X-Public", "ok")).toBe(false);
  });
});

/**
 * Table-driven coverage of the expanded §10.10 category matrix (security-audit
 * S3). Each POSITIVE carries a `leak` substring that must NOT survive masking;
 * each NEGATIVE must pass through byte-for-byte. Two invariants hold across the
 * whole table: the output still contains the `«redacted:` marker for positives,
 * and masking is idempotent.
 */
describe("§10.10 — expanded secret categories (table-driven)", () => {
  interface Pos {
    label: string;
    input: string;
    /** A substring of the secret value that must be gone after masking. */
    leak: string;
    /** A substring that must SURVIVE (structure preserved). */
    keep?: string;
  }

  const positives: Pos[] = [
    // DB-URL passwords
    { label: "postgres url", input: "postgres://user:p4ssw0rd@host:5432/db", leak: "p4ssw0rd", keep: "host" },
    { label: "postgresql url", input: "postgresql://u:topsecretpw@db.internal/app", leak: "topsecretpw" },
    { label: "mongodb+srv url", input: "mongodb+srv://admin:s3cr3tMongo@cluster0.x.net/db", leak: "s3cr3tMongo" },
    { label: "mysql url", input: "mysql://root:mysqlPass123@127.0.0.1:3306/d", leak: "mysqlPass123" },
    { label: "redis url (no user)", input: "redis://:redisPw9999@cache:6379/0", leak: "redisPw9999" },
    { label: "amqp url", input: "amqp://guest:rabbitSecret@mq:5672/vh", leak: "rabbitSecret" },
    // Generic URL userinfo
    { label: "https userinfo", input: "https://alice:hunter2pw@example.com/path", leak: "hunter2pw", keep: "example.com" },
    { label: "ftp userinfo", input: "ftp://bob:ftppassword12@files.example.com", leak: "ftppassword12" },
    // URL query params
    { label: "query token", input: "https://api.example.com/v1?token=abc123tokenvalue&x=1", leak: "abc123tokenvalue", keep: "x=1" },
    { label: "query api_key", input: "https://x.io/?api_key=KEY_abcdefgh12345", leak: "KEY_abcdefgh12345" },
    { label: "query access_token", input: "https://x.io/cb?access_token=ya29.LONGaccessTOKENvalue", leak: "ya29.LONGaccessTOKENvalue" },
    { label: "query sig", input: "https://blob.core/x?sig=sigVALUE9876%3D%3D&comp=list", leak: "sigVALUE9876" },
    { label: "query password", input: "https://x/login?password=plainpw9988", leak: "plainpw9988" },
    { label: "query secret", input: "https://x/?secret=theSecretBit1122", leak: "theSecretBit1122" },
    { label: "query signature", input: "https://x/?signature=sigVALabc1234def", leak: "sigVALabc1234def" },
    { label: "query apikey", input: "https://x/?apikey=apikeyVALUE4455", leak: "apikeyVALUE4455" },
    { label: "query auth", input: "https://x/?auth=authVALUE667788", leak: "authVALUE667788" },
    // npm token
    { label: "npm token", input: "//registry.npmjs.org/:_authToken=npm_01" + "23456789abcdefghijklmnopqrstuvwxyz", leak: "npm_01" + "23456789abcdefghijklmnopqrstuvwxyz" },
    // GitHub tokens
    { label: "github fine-grained", input: "token github" + "_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbbbbccccccccccddddddddddee", leak: "github" + "_pat_11ABCDEFG0aaaaaaaaaaaa" },
    { label: "github classic ghp", input: "GH=ghp_01" + "23456789abcdefghijABCDEFGHIJ0123", leak: "ghp_01" + "23456789abcdefghijABCDEFGHIJ0123" },
    { label: "github gho", input: "gho_01" + "23456789abcdefghijABCDEFGHIJ0123", leak: "gho_01" + "23456789abcdefghijABCDEFGHIJ0123" },
    // GitLab
    { label: "gitlab pat", input: "glpat-" + "ABCDEFghijkl_1234567890", leak: "glpat-" + "ABCDEFghijkl_1234567890" },
    // AWS
    { label: "aws access key id", input: "aws_access_key_id = AKIAIO" + "SFODNN7EXAMPLE", leak: "AKIAIO" + "SFODNN7EXAMPLE" },
    { label: "aws secret (near context)", input: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", leak: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    { label: "aws secret (near AKIA)", input: "AKIAIO" + "SFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", leak: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    // GCP
    { label: "gcp private_key_id", input: '{"private_key_id": "abc123def456privatekeyid789xyz00"}', leak: "abc123def456privatekeyid789xyz00" },
    { label: "gcp client_secret", input: '{"client_secret": "GOCSPX' + '-clientSecretValue1234"}', leak: "GOCSPX" + "-clientSecretValue1234" },
    { label: "gcp private_key PEM", input: '{"private_key": "-----B' + 'EGIN PRIVATE KEY-----\\nMIIEvQ==\\n-----END PRIVATE KEY-----"}', leak: "MIIEvQ==" },
    // Azure
    { label: "azure AccountKey", input: "DefaultEndpointsProtocol=https;AccountKey=azureAccountKeyBase64==;Rest", leak: "azureAccountKeyBase64" },
    { label: "azure SAS", input: "SharedAccessSignature=sasTokenValue9988==", leak: "sasTokenValue9988" },
    // Slack
    { label: "slack webhook", input: "https://hooks." + "slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX", leak: "XXXXXXXXXXXXXXXXXXXXXXXX" },
    { label: "slack token", input: "xoxb-1" + "234567890-ABCDEFGHIJKLMNOP", leak: "xoxb-1" + "234567890-ABCDEFGHIJKLMNOP" },
    // Stripe
    { label: "stripe sk_live", input: "sk_liv" + "e_0123456789abcdefABCDEFGH", leak: "sk_liv" + "e_0123456789abcdefABCDEFGH" },
    { label: "stripe rk_live", input: "rk_liv" + "e_0123456789abcdefABCDEFGH", leak: "rk_liv" + "e_0123456789abcdefABCDEFGH" },
    // Twilio
    { label: "twilio SID key", input: "SK0123" + "456789abcdef0123456789abcdef", leak: "SK0123" + "456789abcdef0123456789abcdef" },
    { label: "twilio auth token near ctx", input: "twilio_auth_token=0123456789abcdef0123456789abcdef", leak: "0123456789abcdef0123456789abcdef" },
    // SendGrid
    { label: "sendgrid", input: "SG.abc" + "defghijklmnopqrstuv.wxyz0123456789ABCDEFGHijklmnopqrstuvwxyz0", leak: "SG.abcdefghijklmnopqrstuv" },
    // Google API key
    { label: "google api key", input: "AIzaSy" + "A0123456789abcdefghijklmnopqrstuv", leak: "AIzaSy" + "A0123456789abcdefghijklmnopqrstuv" },
    // OpenAI
    { label: "openai sk-", input: "OPENAI=sk-abc" + "defghijklmnopqrstuvwx1234", leak: "sk-abc" + "defghijklmnopqrstuvwx1234" },
    // JWT
    { label: "jwt", input: "eyJhbG" + "ciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abc123def456ghi789", leak: "eyJhbGciOiJIUzI1NiJ9" },
    // PEM / SSH
    { label: "rsa private key", input: "-----B" + "EGIN RSA PRIVATE KEY-----\nMIIBOgIBAAIsecret\n-----END RSA PRIVATE KEY-----", leak: "MIIBOgIBAAIsecret" },
    { label: "ec private key", input: "-----B" + "EGIN EC PRIVATE KEY-----\nECkeybody==\n-----END EC PRIVATE KEY-----", leak: "ECkeybody==" },
    { label: "openssh private key", input: "-----B" + "EGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----", leak: "b3BlbnNzaA==" },
    { label: "generic private key", input: "-----B" + "EGIN PRIVATE KEY-----\nMIIgenericbody\n-----END PRIVATE KEY-----", leak: "MIIgenericbody" },
    // .env style
    { label: "env PASSWORD", input: "DB_PASSWORD=supersecretpw123", leak: "supersecretpw123", keep: "DB_PASSWORD" },
    { label: "env SECRET", input: "CLIENT_SECRET: theclientsecret99", leak: "theclientsecret99", keep: "CLIENT_SECRET" },
    { label: "env TOKEN", input: "API_TOKEN = atoken1122334455", leak: "atoken1122334455", keep: "API_TOKEN" },
    { label: "env APIKEY", input: "MY_APIKEY=apikeyvalue778899", leak: "apikeyvalue778899", keep: "MY_APIKEY" },
    { label: "env PRIVATE", input: "PRIVATE_THING=privateval0099", leak: "privateval0099", keep: "PRIVATE_THING" },
    { label: "env CREDENTIAL", input: "DB_CREDENTIAL=credval112233", leak: "credval112233", keep: "DB_CREDENTIAL" },
    { label: "env AUTH", input: "SERVICE_AUTH=authval445566", leak: "authval445566", keep: "SERVICE_AUTH" },
    // Headers
    { label: "authorization bearer", input: 'Authorization: Bearer abcdefBEARERtoken123', leak: "abcdefBEARERtoken123", keep: "Authorization" },
    { label: "authorization basic", input: "Authorization: Basic dXNlcjpwYXNzd29yZA==", leak: "dXNlcjpwYXNzd29yZA==" },
    { label: "x-api-key header", input: "X-Api-Key: xapikeyHeaderValue99", leak: "xapikeyHeaderValue99", keep: "X-Api-Key" },
    { label: "cookie header", input: "Cookie: session=cookieSecretValue1234", leak: "cookieSecretValue1234", keep: "Cookie" },
    { label: "set-cookie header", input: "Set-Cookie: auth=setCookieSecret9988; Path=/", leak: "setCookieSecret9988" },
    { label: "x-auth-token header", input: "X-Auth-Token: xauthTokenValue5566", leak: "xauthTokenValue5566" },
    // CLI flags
    { label: "--password=", input: "mytool --password=cliPasswordSecret1", leak: "cliPasswordSecret1" },
    { label: "--token=", input: "deploy --token=cliTokenSecret22", leak: "cliTokenSecret22" },
    { label: "--api-key=", input: "svc --api-key=cliApiKeySecret33", leak: "cliApiKeySecret33" },
    { label: "curl -u user:pass", input: "curl -u alice:curlPassword44 https://x", leak: "curlPassword44" },
    { label: "mysql -p<secret>", input: "mysql -pmysqlInlinePw55 -h db", leak: "mysqlInlinePw55" },
    { label: "docker login -p", input: "docker login -p dockerLoginSecret66 registry.io", leak: "dockerLoginSecret66" },
  ];

  const negatives: { label: string; input: string }[] = [
    { label: "git short SHA", input: "fixed in commit a1b2c3d" },
    { label: "git full SHA", input: "c187210deadbeef0123456789abcdef012345678" },
    { label: "uuid", input: "id 550e8400-e29b-41d4-a716-446655440000 created" },
    { label: "semver", input: "upgraded express to 4.18.2 today" },
    { label: "semver range", input: "\"@voidrift/core\": \"^1.2.3\"" },
    { label: "maxTokens literal", input: "const opts = { maxTokens: 4096, temperature: 0.2 }" },
    { label: "password as a word", input: "Please reset your password on the settings page." },
    { label: "token count in prose", input: "the prompt used 1200 tokens of the window" },
    { label: "file path", input: "see src/use-cases/secret-mask.ts around line 46" },
    { label: "plain url", input: "docs at https://example.com/getting-started#install" },
    { label: "plain sentence", input: "the quick brown fox jumps over the lazy dog" },
    { label: "data uri base64 in prose", input: "![x](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)" },
    { label: "plain base64", input: "aGVsbG8gd29ybGQgdGhpcyBpcyBwbGFpbiB0ZXh0" },
    { label: "sha256 hash", input: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
    { label: "md5 hash", input: "d41d8cd98f00b204e9800998ecf8427e" },
    { label: "hex color", input: "background: #1a2b3c;" },
    { label: "ip address", input: "the server answered from 192.168.1.42" },
    { label: "env non-secret", input: "NODE_ENV=production" },
    { label: "env PORT", input: "PORT=3000" },
    { label: "docker image tag", input: "image: node:22-alpine" },
    { label: "iso timestamp", input: "created at 2026-10-17T05:53:05.063-05:00" },
    { label: "function call", input: "resolveWithProvenance('baseUrl')" },
  ];

  it.each(positives)("masks positive: $label", ({ input, leak, keep }) => {
    const out = maskValue(input) as string;
    expect(out).not.toContain(leak);
    expect(out).toContain("«redacted:");
    if (keep) expect(out).toContain(keep);
  });

  it.each(negatives)("leaves negative untouched: $label", ({ input }) => {
    expect(maskValue(input)).toEqual(input);
  });

  it("has at least 60 positives and 20 negatives", () => {
    expect(positives.length).toBeGreaterThanOrEqual(60);
    expect(negatives.length).toBeGreaterThanOrEqual(20);
  });

  it("is idempotent: masked output is not re-masked", () => {
    for (const { input } of positives) {
      const once = maskValue(input) as string;
      const twice = maskValue(once) as string;
      expect(twice).toEqual(once);
    }
  });

  it("every category is linear-time on a 1 MB adversarial string (<500 ms each; catastrophic backtracking takes seconds)", () => {
    // Adversarial inputs that would blow up a backtracking engine: long runs of
    // the lead characters of each category with no terminator.
    const mb = 1024 * 1024;
    const adversarial = [
      "Bearer " + "A".repeat(mb),
      "https://u:" + "a".repeat(mb),
      "-----B" + "EGIN RSA PRIVATE KEY-----\n" + "A".repeat(mb),
      "eyJ" + "A".repeat(mb),
      "?token=" + "a".repeat(mb),
      "DB_PASSWORD=" + "x".repeat(mb),
      "AIza" + "a".repeat(mb),
      "ghp_" + "a".repeat(mb),
      "Cookie: " + "a".repeat(mb),
      "aws_secret_access_key = " + "A".repeat(mb),
    ];
    for (const s of adversarial) {
      const start = performance.now();
      maskValue(s);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    }
  });

  it("the planted key value never survives in a masked structure (obs/approval shape)", () => {
    // Mimics a tool-call args map that flows to the obs trail / approval prompt.
    const planted = "ghp_PL" + "ANTEDsecret0123456789abcdefghij";
    const args = {
      command: `curl -H "Authorization: Bearer ${planted}" https://api.github.com`,
      env: { GITHUB_TOKEN: planted },
      note: "deploy step",
    };
    const masked = JSON.stringify(maskValue(args));
    expect(masked).not.toContain(planted);
    expect(masked).toContain("deploy step"); // non-secret structure preserved
  });
});
