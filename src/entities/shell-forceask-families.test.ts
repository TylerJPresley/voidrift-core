/**
 * Destructive-family force-ask table (core-blueprint.md §9.3).
 *
 * The §9.3 defaults are a FLOOR: every destructive family the blueprint
 * enumerates must force-ask through wrapper prefixes, quoting, `\` escapes,
 * `$IFS` splits, absolute binary paths, `&&`/`;`/`|` chains, `$(…)`/backtick
 * substitutions, and flag reordering — while the matching benign commands stay
 * out of the force-ask list. This table proves ≥150 hostile variants classify
 * `dangerous` and ≥150 benign ones do NOT, and that every hostile one stays a
 * force-ask through `Guardian.evaluate` under a broad allow + plan scope +
 * fan-out grant (only an explicit deny beats a force-ask).
 */
import { describe, it, expect } from "vitest";
import { Guardian, builtinGuardrails, classifyCommand, classifyNever, type ShellLists } from "./guardian.js";
import {
  DEFAULT_SHELL_SAFE,
  DEFAULT_SHELL_FORCE_ASK,
  DEFAULT_SHELL_EQUIVALENTS,
  type PermissionRule,
} from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};

/** Hostile variants across every destructive family — each MUST force-ask. */
const HOSTILE: string[] = [
  // ── raw-device / filesystem destruction ──
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "dd of=/dev/nvme0n1",
  "dd of=/dev/sda",
  "dd bs=4M of=/dev/sdb if=/dev/zero",
  "dd if=/dev/urandom of=/dev/sdc1 count=100",
  "sudo dd if=/dev/zero of=/dev/sda",
  "/bin/dd of=/dev/sda",
  "timeout 60 dd of=/dev/nvme0n1",
  "env FOO=1 dd of=/dev/sdb",
  "dd  of=/dev/sda", // extra spacing
  "mkfs.ext4 /dev/sda1",
  "mkfs -t ext4 /dev/sda1",
  "/sbin/mkfs.ext4 /dev/sda1",
  "sudo /sbin/mkfs.ext4 /dev/sda1",
  "mkfs.xfs /dev/sdb",
  "mke2fs /dev/sdc",
  "wipefs -a /dev/sda",
  "wipefs --all /dev/nvme0n1",
  "shred -n 3 /dev/sda",
  "shred -vz /dev/sdb",
  "blkdiscard /dev/nvme0n1",
  "sudo blkdiscard /dev/sda",
  "parted /dev/sda mklabel gpt",
  "fdisk /dev/sda",
  "sfdisk /dev/sda",
  "sgdisk --zap-all /dev/sda",
  "cryptsetup luksFormat /dev/sda1",
  "cryptsetup luksErase /dev/sda1",
  "sudo cryptsetup luksFormat /dev/sdb",
  // ── writes onto system paths ──
  "echo x > /etc/passwd",
  "echo x >/etc/passwd",
  // no-space-before-redirect regression (§9.3 writes onto system paths):
  "echo x>/etc/passwd",
  "echo x> /etc/passwd",
  "echo pwned>>/etc/hosts",
  "echo pwned>> /etc/hosts",
  // subshell/grouping-paren regression (§9.3: a dangerous command inside a
  // subshell is classified the same):
  "( rm -rf / )",
  "(rm -rf /)",
  "( dd of=/dev/sda )",
  "(( rm -rf / ))",
  "( echo x>/etc/passwd )",
  "echo pwned >> /etc/hosts",
  "echo pwned >>/etc/hosts",
  "cat f > /etc/shadow",
  "printf x > /boot/grub/grub.cfg",
  "echo 1 > /sys/kernel/x",
  "echo 1 > /proc/sys/x",
  "echo x > /usr/bin/foo",
  "echo x > /bin/sh",
  "echo x > /sbin/init",
  "echo x > /lib/systemd/x",
  "echo x > /lib64/foo",
  "echo evil > ~/.bashrc",
  "echo evil >> ~/.zshrc",
  "echo evil > ~/.profile",
  "echo evil > $HOME/.bashrc",
  "echo key >> ~/.ssh/authorized_keys",
  "echo x > /dev/sda",
  "echo x > /dev/nvme0n1p1",
  "cat f | sudo tee /etc/hosts",
  "cat f | tee /etc/hosts",
  "tee /etc/resolv.conf",
  "sudo tee -a /etc/sudoers",
  "truncate -s 0 /etc/passwd",
  "truncate --size 0 /etc/passwd",
  "cp evil ~/.ssh/authorized_keys",
  "cp evil $HOME/.ssh/authorized_keys",
  "cp payload /usr/bin/ls",
  "cp a /etc/hosts",
  "mv x /etc/hosts",
  "mv payload /sbin/init",
  "sudo cp evil /etc/sudoers",
  "ln -sf /dev/null /etc/resolv.conf",
  "ln -sf evil ~/.ssh/authorized_keys",
  "ln -fs evil /etc/hosts",
  "sed -i s/a/b/ /etc/fstab",
  "sed -i 's/a/b/' /etc/passwd",
  "sed -i.bak s/a/b/ /etc/hosts",
  "sudo sed -i s/a/b/ /etc/sudoers",
  "echo x > ~/.gnupg/gpg.conf",
  // ── recursive chmod/chown/chgrp on root ──
  "chmod -R 777 /",
  "chmod -R 777 /*",
  "chmod -R 755 ~",
  "chmod -R 777 $HOME",
  "chmod -R 777 $HOME/*",
  "chown -R me /",
  "chown -R me:me /*",
  "chown -R root ~",
  "chgrp -R staff /",
  "sudo chmod -R 777 /",
  "sudo chown -R me /",
  "chmod --recursive 777 /",
  "chown --recursive me /",
  "chmod -Rf 777 /",
  "chmod 777 -R /",
  "chown me -R /",
  // ── fork bombs ──
  ":(){ :|:& };:",
  ":(){ :|:& };: ",
  ":() { :|:& };:",
  ": () { :|:& };:",
  ":  ()  {  :|:&  };:",
  "bomb(){ bomb|bomb& };bomb",
  "f() { f | f & }; f",
  // ── mass process kill ──
  "kill -9 -1",
  "kill -KILL -1",
  "kill -SIGKILL -1",
  "sudo kill -9 -1",
  "killall5",
  "killall5 -9",
  "/sbin/killall5",
  "kill -1 -1",
  // ── power state ──
  "shutdown now",
  "shutdown -h now",
  "shutdown -r now",
  "reboot",
  "sudo reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  "systemctl poweroff",
  "systemctl reboot",
  "systemctl halt",
  "sudo systemctl poweroff",
  // ── firewall flush ──
  "iptables -F",
  "sudo iptables -F",
  "ip6tables -F",
  "iptables -t nat -F",
  "nft flush ruleset",
  "nft flush table ip filter",
  "ufw disable",
  "ufw reset",
  "sudo ufw disable",
  // ── infra / data destruction ──
  "terraform destroy",
  "terraform destroy -auto-approve",
  "terraform apply -destroy -auto-approve",
  "terraform -chdir=env apply -destroy",
  "kubectl delete ns prod",
  "kubectl delete namespace prod",
  "kubectl delete ns prod --now",
  "kubectl delete pods --all",
  "kubectl delete deploy --all -n prod",
  "helm uninstall myrelease",
  "helm delete myrelease",
  "docker system prune -a",
  "docker system prune -af",
  "docker volume rm myvol",
  "docker rm -f mycontainer",
  "docker rm -fv x",
  "aws ec2 terminate-instances --instance-ids i-123",
  "aws rds delete-db-instance --db-instance-identifier x",
  "aws s3api delete-object --bucket b --key k",
  // owner D1.4 additions: aws s3 rm/rb and killall <name>/bare killall always-ask
  "aws s3 rm s3://bucket/key",
  "aws s3 rm s3://bucket --recursive",
  "aws s3 rb s3://bucket",
  "killall node",
  "killall -9 chrome",
  "killall",
  "gcloud compute instances delete vm1",
  "az group delete --name rg1",
  "psql -c 'DROP TABLE x'",
  "psql -c \"DROP DATABASE prod\"",
  "psql -c 'TRUNCATE t'",
  "mysql -e 'DROP TABLE x'",
  "mysql -e \"TRUNCATE users\"",
  "sqlite3 db 'DROP TABLE x'",
  "psql -c 'drop table x'",
  "redis-cli FLUSHALL",
  "redis-cli FLUSHDB",
  "redis-cli -h x FLUSHALL",
  "mongo mydb --eval 'db.dropDatabase()'",
  "mongosh --eval 'db.dropDatabase()'",
  // ── git history destruction ──
  "git filter-branch --tree-filter x HEAD",
  "git filter-repo --path x",
  "git reflog expire --expire=now --all",
  "git gc --prune=now",
  "git update-ref -d refs/heads/x",
  "git -C /repo filter-branch -- --all",
  // ── wrapper / substitution / chain / escape evasions across families ──
  "env chmod -R 777 /",
  "timeout 5 chmod -R 777 /",
  "nice -n 5 mkfs.ext4 /dev/sda",
  "a=1 b=2 reboot",
  "chmod\\ -R\\ 777\\ /", // backslash-escaped spaces collapse
  "chmod${IFS}-R${IFS}777${IFS}/", // $IFS splitting
  "'reboot'",
  "\"poweroff\"",
  "re''boot",
  "sh -c 'chmod -R 777 /'",
  "bash -c 'mkfs.ext4 /dev/sda'",
  "eval reboot",
  "ls && reboot",
  "echo hi; shutdown now",
  "true && docker system prune -a",
  "echo $(reboot)",
  "echo `poweroff`",
  "false || terraform destroy",
  "/sbin/reboot",
  "/usr/sbin/shutdown now",
  "command reboot",
  "nohup shutdown -h now",
  "xargs rm -rf < list", // (rm -rf already covered; wrapper-chained)
  "sudo env chmod -R 777 /",
];

/** Benign variants that MUST NOT force-ask (same tools, safe targets/flags). */
const BENIGN: string[] = [
  "greet() { echo hi; }",
  "build(){ make all; }",
  "ll() { ls -l; }",
  // dd on regular files, cp/mv/ln/sed/chmod on workspace paths
  "dd if=a of=b",
  "dd if=./in of=./out bs=1M",
  "dd if=backup.img of=restore.img",
  "cp a b",
  "cp -r src dst",
  "cp a ./out.txt",
  "cp a b/c.txt",
  "mv a b",
  "mv old.txt new.txt",
  "mv src/a src/b",
  "ln -s a b",
  "ln -sf a ./link",
  "ln -sf ./src ./dist",
  "sed -i s/a/b/ src/a.ts",
  "sed -i 's/a/b/' README.md",
  "sed -i.bak s/x/y/ file.txt",
  "sed s/a/b/ file",
  "chmod 644 file",
  "chmod 755 script.sh",
  "chmod -R u+rw ./src",
  "chmod -R 755 build/",
  "chmod +x bin/run",
  "chown me file",
  "chown -R me ./project",
  "chgrp staff ./dir",
  "tee out.txt",
  "tee -a ./log.txt",
  "truncate -s 0 ./tmp.log",
  // redirections to workspace paths
  "echo x > ./out.txt",
  "echo x > out.txt",
  "echo x >> log.txt",
  "echo > /tmp/x",
  "echo x > /tmp/scratch-test",
  "cat a > b",
  "printf x > ./file",
  "node build.js > dist/out.js",
  // kill a real pid
  "kill 1234",
  "kill -9 1234",
  "kill -TERM 5678",
  "kill -15 999",
  // docker / k8s / infra read & non-destructive
  "docker ps",
  "docker ps -a",
  "docker images",
  "docker build -t x .",
  "docker run hello-world",
  "docker system df",
  "docker volume ls",
  "docker rm mycontainer", // no -f
  "kubectl get ns",
  "kubectl get pods",
  "kubectl get ns prod",
  "kubectl apply -f x.yaml",
  "kubectl describe ns prod",
  "helm install myrelease ./chart",
  "helm list",
  "helm upgrade myrelease ./chart",
  "terraform plan",
  "terraform apply",
  "terraform apply -auto-approve",
  "terraform init",
  "terraform validate",
  "terraform fmt",
  // cloud read ops
  "aws s3 ls",
  "aws ec2 describe-instances",
  "aws s3 cp a s3://bucket/a",
  "gcloud compute instances list",
  "gcloud projects describe x",
  "az group list",
  "az vm list",
  // SQL select / non-destructive
  "psql -c 'SELECT 1'",
  "psql -c \"SELECT * FROM t\"",
  "psql -l",
  "mysql -e 'SELECT 1'",
  "mysql -e 'SHOW TABLES'",
  "sqlite3 db 'SELECT * FROM t'",
  "sqlite3 db .tables",
  "redis-cli GET key",
  "redis-cli PING",
  "redis-cli SET k v",
  "mongo mydb --eval 'db.coll.find()'",
  "mongosh --eval 'db.coll.countDocuments()'",
  // git non-destructive (incl. ones that look near history ops)
  "git push origin feature",
  "git push",
  "git gc",
  "git gc --auto",
  "git reflog",
  "git reflog expire --expire=90.days",
  "git update-ref refs/heads/x HEAD",
  "git log",
  "git status",
  "git fetch --all",
  // power / firewall / fs look-alikes that are safe
  "shutdownhelper --status", // not the `shutdown` command word
  "echo shutdown now", // echo prints the word
  "ls /etc",
  "cat /etc/hosts",
  "grep root /etc/passwd",
  "iptables -L",
  "iptables -S",
  "nft list ruleset",
  "ufw status",
  "systemctl status nginx",
  "systemctl start nginx",
  "systemctl restart docker",
  "init --help",
  "mkdir -p x",
  "mkdir build",
  "touch /tmp/x",
  "touch ./file",
  "parted --version", // no device operand
  "fdisk -l", // list only, no device
  "dd --version",
  "apt update",
  "systemctl status nginx",
  // wrappers running benign commands
  "timeout 30 npm test",
  "nice -n 5 make",
  "env FOO=1 npm run build",
  "nohup npm start",
  "node app.js",
  "python app.py",
  // sed/cp/mv/chmod with no system path and no recursion-on-root
  "chmod -R 777 ./node_modules",
  "chown -R me:me ./dist",
  "cp -a ./a ./b",
  "sed -i s/a/b/ ./deep/nested/file.ts",
  "ln -sf ./node_modules/.bin/x ./x",
  "cp config.example.json config.json",
  // more plainly-benign everyday commands
  "ls -la",
  "pwd",
  "cd src",
  "echo hello",
  "echo done > ./status.txt",
  "cat package.json",
  "head -n 20 file.txt",
  "tail -f ./log.txt",
  "wc -l src/*.ts",
  "find . -name '*.ts'",
  "grep -r TODO src",
  "npm install",
  "npm ci",
  "npm run build",
  "npm test",
  "npx vitest --run",
  "git add -A",
  "git commit -m wip",
  "git checkout -b feature",
  "git merge main",
  "git stash",
  "git rebase main",
  "make build",
  "make test",
  "curl -s https://example.com",
  "wget https://example.com/file",
  "tar -czf out.tgz ./dist",
  "unzip archive.zip",
  "rsync -a ./src ./backup",
  "ssh host 'uptime'",
  "docker compose up -d",
  "docker logs mycontainer",
];

describe("destructive-family force-ask table (§9.3)", () => {
  it(`has ≥150 hostile and ≥150 benign variants`, () => {
    expect(HOSTILE.length).toBeGreaterThanOrEqual(150);
    expect(BENIGN.length).toBeGreaterThanOrEqual(150);
  });

  it.each(HOSTILE)("hostile → force-ask: %s", (cmd) => {
    const { cls } = classifyCommand(cmd, lists);
    expect(cls, `expected dangerous for: ${cmd}`).toBe("dangerous");
  });

  it.each(BENIGN)("benign → NOT force-ask: %s", (cmd) => {
    const { cls } = classifyCommand(cmd, lists);
    expect(cls, `expected NOT dangerous for: ${cmd}`).not.toBe("dangerous");
  });

  it("every hostile variant denies-or-force-asks through Guardian under broad allow + plan scope + fan-out grant", () => {
    const guardian = new Guardian(builtinGuardrails());
    const rules: PermissionRule[] = [
      { tool: "*", pattern: "*", decision: "allow", priority: 1000, source: "session" },
    ];
    guardian.registerScope("plan", { executePatterns: ["*"], writeGlobs: ["*"] });
    guardian.grantFanout("fan-1");
    const noUnlock = new Set<string>();
    for (const cmd of HOSTILE) {
      const out = guardian.evaluate(
        { tool: "execute_command", args: { command: cmd } },
        rules,
        lists,
      );
      // A code-level NEVER LIST command DENIES outright (immune to the broad
      // allow + scope + grant, no prompt); every other destructive command
      // stays a force-ask. Neither is ever auto-approved.
      if (classifyNever(cmd, noUnlock)) {
        expect(out.decision, `never-list: ${cmd}`).toBe("deny");
      } else {
        expect(out.decision, cmd).toBe("ask");
        expect(out.forceAsk, cmd).toBe(true);
      }
    }
  });

  it("an explicit deny still blocks a destructive command outright", () => {
    const guardian = new Guardian(builtinGuardrails());
    const denyLists: ShellLists = { ...lists, deny: ["(?:\\S*/)?reboot(?: .*)?"] };
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "reboot" } },
      [],
      denyLists,
    );
    expect(out.decision).toBe("deny");
  });
});
