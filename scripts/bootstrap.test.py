"""Offline bootstrap command tests: only disposable roots and stubbed host effects."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash")


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wag-bootstrap-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.root = self.base / "root"
        self.bin = self.base / "bin"
        self.effects = self.base / "effects"
        self.bin.mkdir()
        for name in ("scripts", "config", "gateway", "crawl4ai", "systemd", "proxy", "runtime/playwright-mcp"):
            (self.source / name).mkdir(parents=True)
        for file in (SOURCE / "config").glob("*.template"):
            shutil.copy2(file, self.source / "config" / file.name)
        # The script is unmodified except its installation destination. No real
        # /data or /etc writes are possible: privileged/external commands below
        # are replaced, and the real file utilities see only this temporary tree.
        script = (SOURCE / "scripts/bootstrap.sh").read_text()
        self.assertIn("ROOT=/data/web-access-gateway", script)
        script = script.replace("ROOT=/data/web-access-gateway", 'ROOT="$TEST_ROOT"', 1)
        (self.source / "scripts/bootstrap.sh").write_text(script, newline="\n")
        for file in (SOURCE / "scripts").glob("bootstrap-bind.py"):
            shutil.copy2(file, self.source / "scripts" / file.name)
        (self.source / "gateway/server.mjs").write_text("// installation fixture\n")
        (self.source / "crawl4ai/app.py").write_text("# installation fixture\n")
        self.stub("id", 'case "$1" in -u) printf "0\\n";; -gn) printf "dummy\\n";; *) exit 91;; esac')
        self.stub("install", 'printf "install\\n" >> "$TEST_EFFECTS"; args=(); while (($#)); do case "$1" in -o|-g|-m) shift 2;; -d) shift;; *) args+=("$1"); shift;; esac; done; /usr/bin/mkdir -p "${args[@]}"')
        for name in ("apt-get", "chown", "chmod", "runuser", "ln", "systemctl"):
            self.stub(name, 'printf "%s\\n" "${0##*/}" >> "$TEST_EFFECTS"')
        for name in ("sudo", "curl", "tar"):
            self.stub(name, 'printf "unexpected external command\\n" >&2; exit 91')
        self.stub("openssl", 'printf "%064d\\n" 0')
        node = self.root / "runtime/node/bin/node"
        node.parent.mkdir(parents=True)
        node.write_text('#!/usr/bin/env bash\nprintf "v22.23.2\\n"\n', newline="\n")
        node.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("GATEWAY_", "CRAWL4AI_"))}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        TEST_ROOT=self.root.as_posix(), TEST_EFFECTS=self.effects.as_posix(),
                        SUDO_USER="dummy")
        self.env.pop("MSYS_NO_PATHCONV", None)
        self.env.pop("MSYS2_ARG_CONV_EXCL", None)
        # Stub only the OS DNS boundary for reserved fixture names. Never ask
        # public DNS about unresolved or mixed-answer targets in this suite.
        dns_fixture = self.base / "dns-fixture"
        dns_fixture.mkdir()
        (dns_fixture / "sitecustomize.py").write_text('''import socket
original = socket.getaddrinfo
def fixture(host, port, *args, **kwargs):
    if host == "unresolved.invalid":
        raise socket.gaierror("fixture resolution failure")
    if host == "mixed.invalid":
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.1", 0))]
    return original(host, port, *args, **kwargs)
socket.getaddrinfo = fixture
''', newline="\n")
        self.env["PYTHONPATH"] = str(dns_fixture)

    def stub(self, name, body):
        file = self.bin / name
        file.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n", newline="\n")
        file.chmod(0o755)

    def run_bootstrap(self, **env):
        return subprocess.run([BASH, str(self.source / "scripts/bootstrap.sh")],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=20)

    def config(self):
        return dict(line.split("=", 1) for line in
                    (self.root / "secrets/gateway.env").read_text().splitlines() if "=" in line)

    def test_fresh_install_is_loopback_with_usable_host_allowlist(self):
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.config()
        self.assertEqual(config["GATEWAY_BIND_HOST"], "127.0.0.1")
        self.assertEqual(config["GATEWAY_HOST"], "yosef-server")
        self.assertEqual(config["GATEWAY_ALLOWED_HOSTS"], "yosef-server,localhost,127.0.0.1,[::1]")
        self.assertIn("systemctl", self.effects.read_text())

    def test_explicit_local_override_is_installed_without_changing_public_hostname(self):
        result = self.run_bootstrap(GATEWAY_BIND_HOST="localhost")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config()["GATEWAY_BIND_HOST"], "localhost")
        self.assertEqual(self.config()["GATEWAY_HOST"], "yosef-server")

    def snapshot(self):
        return {str(file.relative_to(self.root)): file.read_bytes()
                for file in self.root.rglob("*") if file.is_file()}

    def assert_rejected_without_effects(self, target=None):
        before = self.snapshot()
        result = self.run_bootstrap(**({} if target is None else {"GATEWAY_BIND_HOST": target}))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("GATEWAY_BIND_HOST", result.stderr)
        if target and target.strip():
            self.assertNotIn(target, result.stdout + result.stderr)
        self.assertFalse(self.effects.exists(), "no package, filesystem, or service commands before validation")
        self.assertEqual(before, self.snapshot())

    def test_placeholder_fails_before_installation_and_does_not_echo_input(self):
        self.assert_rejected_without_effects("__DIRECT_WIRED_ADDRESS__")

    def test_invalid_nonlocal_and_unresolved_inputs_fail_before_effects(self):
        for target in ("", " ", "127.0.0.1 ", "127.1", "999.1.2.3", "[::1]", "localhost:8930",
                       "http://dummy:dummy@localhost", "$DUMMY_BIND", "bad\nDUMMY_TOKEN=not-a-live-token",
                       "192.0.2.1", "2001:db8::1", "unresolved.invalid", "mixed.invalid"):
            with self.subTest(target=target):
                self.assert_rejected_without_effects(target)

    def test_invalid_override_is_rejected_before_privilege_escalation(self):
        self.stub("id", 'printf "privilege-check\\n" >> "$TEST_EFFECTS"; printf "1000\\n"')
        self.assert_rejected_without_effects("__UNRESOLVED__")

    def test_invalid_template_bind_fails_before_effects(self):
        file = self.source / "config/gateway.env.template"
        file.write_text(file.read_text().replace("GATEWAY_BIND_HOST=127.0.0.1", "GATEWAY_BIND_HOST=__UNRESOLVED__"))
        self.assert_rejected_without_effects()

    def test_existing_configuration_and_dummy_credentials_are_preserved(self):
        secrets = self.root / "secrets"
        secrets.mkdir()
        gateway = secrets / "gateway.env"
        gateway.write_text("GATEWAY_HOST=custom-public.invalid\nGATEWAY_BIND_HOST=\"127.0.0.1\"\n"
                           "GATEWAY_TOKEN=dummy-existing-gateway-credential\n"
                           "CRAWL4AI_TOKEN=dummy-existing-crawl-credential\n"
                           "GATEWAY_ALLOWED_HOSTS=custom-public.invalid,127.0.0.1\nCUSTOM_SETTING=keep\n")
        crawl = secrets / "crawl4ai.env"
        crawl.write_text("CRAWL4AI_TOKEN=dummy-existing-crawl-credential\nCUSTOM_SETTING=keep\n")
        custom = self.root / "config/operator.conf"
        custom.parent.mkdir()
        custom.write_text("operator configuration to preserve\n")
        before = [file.read_bytes() for file in (gateway, crawl, custom)]
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, [file.read_bytes() for file in (gateway, crawl, custom)])
        self.assertNotIn("dummy-existing", result.stdout + result.stderr)

    def test_existing_invalid_bind_and_conflicting_override_are_not_rewritten(self):
        secrets = self.root / "secrets"
        secrets.mkdir()
        gateway = secrets / "gateway.env"
        for target, override in (("__UNRESOLVED__", None), ("192.0.2.1", None), ("127.0.0.1", "localhost")):
            with self.subTest(target=target, override=override):
                gateway.write_text("GATEWAY_BIND_HOST=" + target + "\nCRAWL4AI_TOKEN=dummy-existing-credential\n")
                self.assert_rejected_without_effects(override)

    def test_multicast_and_broadcast_are_not_listen_overrides(self):
        for target in ("224.0.0.1", "255.255.255.255", "ff02::1", "::ffff:224.0.0.1", "::ffff:255.255.255.255"):
            with self.subTest(target=target):
                self.assert_rejected_without_effects(target)

    def test_explicit_wildcard_is_intentional_not_a_default_or_fallback(self):
        result = self.run_bootstrap(GATEWAY_BIND_HOST="0.0.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config()["GATEWAY_BIND_HOST"], "0.0.0.0")
        self.assertEqual(self.config()["GATEWAY_HOST"], "yosef-server")

    def test_explicit_ipv6_loopback_is_preserved(self):
        result = self.run_bootstrap(GATEWAY_BIND_HOST="::1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config()["GATEWAY_BIND_HOST"], "::1")


if __name__ == "__main__":
    unittest.main()
