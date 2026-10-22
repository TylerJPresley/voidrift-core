import { describe, it, expect } from "vitest";
import { Guardian, builtinGuardrails, type ShellLists } from "./guardian.js";
import { DEFAULT_SHELL_SAFE, DEFAULT_SHELL_FORCE_ASK, DEFAULT_SHELL_EQUIVALENTS } from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};

const guardian = new Guardian(builtinGuardrails());
const ask = (command: string): boolean => {
  const out = guardian.evaluate({ tool: "execute_command", args: { command } }, [], lists);
  return out.decision === "ask" && out.forceAsk === true;
};

describe("option-smuggling force-ask families (owner S1 / audit MEDIUM)", () => {
  const forceAsked: [string, string][] = [
    ["git -c core.sshCommand", "git -c core.sshCommand=/tmp/x clone u@h:/r"],
    ["git -c core.fsmonitor", "git -c core.fsmonitor=/tmp/x status"],
    ["git -c core.hooksPath", "git -c core.hooksPath=/tmp status"],
    ["git -c protocol.ext.allow", "git -c protocol.ext.allow=always fetch"],
    ["git clone --upload-pack", "git clone --upload-pack=/tmp/x ext::sh origin"],
    ["git fetch --receive-pack", "git fetch --receive-pack=/tmp/x origin"],
    ["git push --exec", "git push --exec=/tmp/x origin main"],
    ["ssh -o ProxyCommand", "ssh -o ProxyCommand=/tmp/x host"],
    ["ssh -o LocalCommand", "ssh -o LocalCommand=/tmp/x host"],
    ["scp -o ProxyCommand", "scp -o ProxyCommand=/tmp/x a host:b"],
    ["rsync -e", "rsync -e /tmp/x a host:b"],
    ["rsync --rsh=", "rsync --rsh=/tmp/x a host:b"],
    ["tar --to-command", "tar --to-command=/tmp/x -xf a.tar"],
    ["tar --checkpoint-action", "tar --checkpoint-action=exec=/tmp/x -xf a.tar"],
    ["tar --use-compress-program", "tar --use-compress-program=/tmp/x -xf a.tar"],
    ["tar -I", "tar -I /tmp/x -xf a.tar"],
    ["crontab", "crontab -l"],
    ["at", "at now + 1 minute"],
    ["batch", "batch"],
    ["systemd-run", "systemd-run /tmp/x"],
    ["systemctl enable", "systemctl enable evil.service"],
    ["chattr", "chattr +i /etc/passwd"],
    ["mount", "mount /dev/sda1 /mnt"],
    ["umount", "umount /mnt"],
    ["setcap", "setcap cap_setuid+ep /tmp/x"],
    ["visudo", "visudo"],
    ["passwd", "passwd root"],
    ["usermod", "usermod -aG sudo me"],
    ["useradd", "useradd evil"],
    ["userdel", "userdel bob"],
  ];
  it.each(forceAsked)("%s force-asks", (_label, command) => {
    expect(ask(command)).toBe(true);
  });

  // Bypass attempts: quoting, env prefix, absolute path, sudo.
  const bypasses: [string, string][] = [
    ["env prefix", "FOO=1 git -c core.sshCommand=/tmp/x clone u@h:/r"],
    ["sudo", "sudo mount /dev/sda1 /mnt"],
    ["absolute path", "/usr/bin/crontab -l"],
    ["wrapper", "timeout 5 systemctl enable evil.service"],
    ["quoting", "ch''attr +i /etc/passwd"],
  ];
  it.each(bypasses)("bypass via %s is still force-asked", (_label, command) => {
    expect(ask(command)).toBe(true);
  });

  it("an ordinary safe git command is NOT force-asked", () => {
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "git status" } }, [], lists);
    expect(out.decision).toBe("allow");
  });
});
