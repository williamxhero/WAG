#!/usr/bin/env python3
"""Preflight the listen target without evaluating secret-bearing env files."""
import ipaddress
import os
from pathlib import Path
import re
import socket
import sys


class BindError(Exception):
    pass


def validate(target):
    if not target or target != target.strip() or "__" in target:
        raise BindError("empty, whitespace, or unresolved-placeholder value")
    try:
        ipaddress.ip_address(target)
    except ValueError:
        # No URLs, ports, bracketed IPs, shell/env expansion, or abbreviated IPs.
        labels = target.removesuffix(".").split(".")
        if (len(target) > 253 or re.fullmatch(r"[0-9.]+", target)
                or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                       for label in labels)):
            raise BindError("expected an IP address or hostname, not a URL or host:port")
    try:
        addresses = socket.getaddrinfo(target, 0, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        raise BindError("listen target could not be resolved") from None
    if not addresses:
        raise BindError("listen target could not be resolved")
    # Check every answer: Node may choose any returned address. Binding an
    # ephemeral port verifies local ownership without starting a service.
    for family, kind, protocol, _, address in addresses:
        ip = ipaddress.ip_address(address[0])
        if isinstance(ip, ipaddress.IPv6Address):
            ip = ip.ipv4_mapped or ip
        if ip.is_multicast or str(ip) == "255.255.255.255":
            raise BindError("multicast and broadcast addresses are not local listen targets")
        try:
            with socket.socket(family, kind, protocol) as probe:
                probe.bind(address)
        except OSError:
            raise BindError("listen target is nonlocal or unavailable on this host") from None
    return target


def configured_bind(file, existing):
    values = {}
    for line in file.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() in ("GATEWAY_BIND_HOST", "GATEWAY_HOST"):
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip()] = value
    if "GATEWAY_BIND_HOST" in values:
        return values["GATEWAY_BIND_HOST"]
    if existing:
        # Match the gateway's legacy fallback, but never rewrite existing files.
        return values.get("GATEWAY_HOST", "yosef-server")
    raise BindError("fresh-install template has no bind address")


def main():
    override = os.environ.get("GATEWAY_BIND_HOST")
    if override is not None:
        validate(override)
    if sys.argv[1:] == ["--override"]:
        return
    secret, template = map(Path, sys.argv[1:])
    existing = secret.is_file() and secret.stat().st_size > 0
    target = validate(configured_bind(secret if existing else template, existing))
    if existing and override is not None and override != target:
        raise BindError("override differs from existing configuration; edit it explicitly instead")
    print(target if existing or override is None else override)


if __name__ == "__main__":
    try:
        main()
    except (BindError, OSError, UnicodeError) as error:
        # Never include the supplied target, file contents, or OS exception:
        # malformed values can contain credentials/control characters.
        detail = str(error) if isinstance(error, BindError) else "unable to read bind configuration"
        print("GATEWAY_BIND_HOST validation failed: " + detail +
              ". Use a local IP/hostname; remote access needs an explicit local bind override.",
              file=sys.stderr)
        sys.exit(2)
