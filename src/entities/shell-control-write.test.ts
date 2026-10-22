import { describe, it, expect } from "vitest";
import { controlPathWriteTargets } from "./shell-control-write.js";

describe("controlPathWriteTargets (owner S1)", () => {
  it("extracts redirection targets (>, >>, >|, &>, N>)", () => {
    expect(controlPathWriteTargets("echo x > a.txt")).toContain("a.txt");
    expect(controlPathWriteTargets("echo x >> a.txt")).toContain("a.txt");
    expect(controlPathWriteTargets("echo x >| a.txt")).toContain("a.txt");
    expect(controlPathWriteTargets("cmd &> a.log")).toContain("a.log");
    expect(controlPathWriteTargets("cmd 2> err.log")).toContain("err.log");
  });

  it("extracts write-command operands (cp/mv/tee/rm/ln/sed -i/dd of=)", () => {
    expect(controlPathWriteTargets("cp src dst")).toEqual(expect.arrayContaining(["src", "dst"]));
    expect(controlPathWriteTargets("mv a b")).toContain("b");
    expect(controlPathWriteTargets("echo x | tee cfg")).toContain("cfg");
    expect(controlPathWriteTargets("rm f")).toContain("f");
    expect(controlPathWriteTargets("sed -i s/a/b/ file")).toContain("file");
    expect(controlPathWriteTargets("dd if=/dev/zero of=target")).toContain("target");
  });

  it("maps a dangerous git config write to a synthetic .git/config target", () => {
    expect(controlPathWriteTargets("git config core.hooksPath /tmp/x")).toContain(".git/config");
    expect(controlPathWriteTargets("git config core.sshCommand /tmp/x")).toContain(".git/config");
    expect(controlPathWriteTargets("git config alias.co checkout")).toContain(".git/config");
  });

  it("a git config READ (no value) yields no target", () => {
    expect(controlPathWriteTargets("git config --get core.hooksPath")).not.toContain(".git/config");
  });

  it("a benign/ordinary read command yields no write targets", () => {
    expect(controlPathWriteTargets("cat file")).toEqual([]);
    expect(controlPathWriteTargets("ls -la")).toEqual([]);
    expect(controlPathWriteTargets("git diff")).toEqual([]);
  });

  it("de-quotes a quoted redirect target", () => {
    expect(controlPathWriteTargets('echo x > ".voidrift/config.json"')).toContain(".voidrift/config.json");
  });

  it("scans inner commands of an interpreter wrapper", () => {
    expect(controlPathWriteTargets('bash -c "echo x > .git/hooks/pre-commit"')).toContain(".git/hooks/pre-commit");
  });

  it("skips a leading env assignment / wrapper to find the command word", () => {
    expect(controlPathWriteTargets("FOO=1 sudo cp evil /etc/passwd")).toContain("/etc/passwd");
  });
});
