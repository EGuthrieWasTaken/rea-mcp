#!/usr/bin/env python3
"""Check unraid/rea-mcp.xml against the `unraid-template` spec (openspec: unraid-template, D11).

    python3 scripts/check_template.py               check the template in this repository
    python3 scripts/check_template.py --self-test   seed deliberate violations; each must be rejected

It needs nothing but the Python 3 standard library. It reports every violation, not just the first, and
exits 1 if there is any. The checks are:

  - the XML is well formed, and the root is <Container version="2">;
  - the metadata elements exist, are not empty, and have the values the spec fixes (lowercase repository,
    `Tools:` category, project, support and raw GitHub links, hardening flags, bridge, not privileged, no WebUI);
  - every <Config> has the seven attributes, the required entries exist with the right Type, Target, Mode,
    Mask, Required and defaults, and the eight advanced variables are advanced and carry the gateway's defaults,
    which are read from DEFAULT_ENV in src/config.ts so that the two cannot drift;
  - the checkpoint variable is off by default and its description warns as the spec requires;
  - the template holds no key, no long hex or base64-looking string, no private key, no host other than public
    GitHub and GHCR, and no host path other than the conventional appdata default;
  - the icon the template points at is unraid/icon.png and is a valid, single-frame PNG.
"""
from __future__ import annotations

import argparse
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_REL = Path("unraid/rea-mcp.xml")
ICON_REL = Path("unraid/icon.png")
CONFIG_TS_REL = Path("src/config.ts")

OWNER_REPO = "EGuthrieWasTaken/rea-mcp"
EXPECTED = {
    "Repository": "ghcr.io/eguthriewastaken/rea-mcp:latest",
    "Category": "Tools:",
    "Project": f"https://github.com/{OWNER_REPO}",
    "Support": f"https://github.com/{OWNER_REPO}/issues",
    "TemplateURL": f"https://raw.githubusercontent.com/{OWNER_REPO}/main/unraid/rea-mcp.xml",
    "Icon": f"https://raw.githubusercontent.com/{OWNER_REPO}/main/unraid/icon.png",
    "Network": "bridge",
    "Privileged": "false",
}
METADATA = ["Name", "Repository", "Registry", "Shell", "Support", "Project", "Overview", "Category", "TemplateURL", "Icon"]
CONFIG_ATTRS = ["Type", "Target", "Default", "Mode", "Display", "Required", "Mask"]
ADVANCED = [
    "MAX_SESSIONS",
    "SESSION_IDLE_TIMEOUT_SEC",
    "TRUST_PROXY",
    "ALLOWED_HOSTS",
    "GHIDRA_MAX_HEAP",
    "REA_GHIDRA_STARTUP_TIMEOUT_MS",
    "REA_GHIDRA_CHECKPOINT_DIR",
    "LOG_LEVEL",
]
EXTRA_PARAMS_REQUIRED = ["--cap-drop=ALL", "--security-opt=no-new-privileges:true"]
ALLOWED_URL_HOSTS = {"github.com", "raw.githubusercontent.com", "ghcr.io"}
APPDATA_DEFAULT = "/mnt/user/appdata/rea-mcp"


# --- the gateway's defaults ----------------------------------------------------------------------------
def gateway_defaults(root: Path) -> dict[str, str]:
    """DEFAULT_ENV from src/config.ts, as {name: default string}."""
    text = (root / CONFIG_TS_REL).read_text(encoding="utf-8")
    block = re.search(r"export const DEFAULT_ENV = \{(.*?)\} as const;", text, re.S)
    if block is None:
        raise ValueError(f"cannot find DEFAULT_ENV in {CONFIG_TS_REL}; update scripts/check_template.py")
    entries = dict(re.findall(r'^\s*([A-Z][A-Z0-9_]*):\s*"([^"]*)",?\s*(?://.*)?$', block.group(1), re.M))
    missing = [name for name in ["PORT", *ADVANCED] if name not in entries]
    if missing:
        raise ValueError(f"DEFAULT_ENV in {CONFIG_TS_REL} does not define {', '.join(missing)}")
    return entries


# --- the icon ------------------------------------------------------------------------------------------
def png_errors(path: Path) -> list[str]:
    """Why `path` is not a valid, single-frame PNG; empty if it is."""
    if not path.is_file():
        return [f"{path} does not exist"]
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return [f"{path.name} does not start with the PNG signature"]
    pos, kinds, idat, header = 8, [], [], b""
    while pos < len(data):
        if pos + 12 > len(data):
            return [f"{path.name} is truncated inside a chunk"]
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if pos + 12 + length > len(data):
            return [f"{path.name} is truncated inside a {kind.decode('latin-1')} chunk"]
        crc = struct.unpack(">I", data[pos + 8 + length : pos + 12 + length])[0]
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            return [f"{path.name} has a bad CRC in its {kind.decode('latin-1')} chunk"]
        name = kind.decode("latin-1")
        kinds.append(name)
        if name == "IHDR":
            header = body
        if name == "IDAT":
            idat.append(body)
        pos += 12 + length
    errors = []
    if not kinds or kinds[0] != "IHDR" or kinds[-1] != "IEND":
        errors.append(f"{path.name} does not run from IHDR to IEND")
    animated = sorted({"acTL", "fcTL", "fdAT"} & set(kinds))
    if animated:
        errors.append(f"{path.name} is animated (it has {', '.join(animated)} chunks); the icon must not be")
    if len(header) == 13 and not errors:
        width, height, depth, colour = struct.unpack(">IIBB", header[:10])
        if (width, height) != (256, 256):
            errors.append(f"{path.name} is {width}x{height}; the planned size is 256x256 (docs/DESIGN.md, 10.2)")
        channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(colour)
        if channels is None or depth != 8 or header[12] != 0:
            errors.append(f"{path.name} is not an 8-bit, non-interlaced greyscale, RGB or RGBA image")
        else:
            try:
                raw = zlib.decompress(b"".join(idat))
            except zlib.error:
                errors.append(f"{path.name} has pixel data that does not decompress")
            else:
                if len(raw) != height * (1 + width * channels):
                    errors.append(f"{path.name} has pixel data whose length does not match its header")
    elif len(header) != 13:
        errors.append(f"{path.name} has no valid IHDR chunk")
    return errors


# --- the template --------------------------------------------------------------------------------------
def check(root: Path, template: Path | None = None) -> list[str]:
    """Every way the template at `template` (default: the one under `root`) violates the spec."""
    template = template or root / TEMPLATE_REL
    errors: list[str] = []
    bad = errors.append

    try:
        tree = ET.parse(template)
    except (ET.ParseError, OSError) as exc:
        return [f"{template.name} is not well-formed XML: {exc}"]
    top = tree.getroot()
    if top.tag != "Container" or top.get("version") != "2":
        bad(f'the root element must be <Container version="2">, not <{top.tag} version="{top.get("version")}">')

    def text(tag: str) -> str:
        found = top.find(tag)
        return "" if found is None or found.text is None else found.text.strip()

    for tag in METADATA:
        if text(tag) == "":
            bad(f"<{tag}> is missing or empty")
    for tag, want in EXPECTED.items():
        if text(tag) != want:
            bad(f"<{tag}> is {text(tag)!r}; it must be {want!r}")
    if text("Repository") != text("Repository").lower():
        bad("<Repository> must be all lowercase")
    for flag in EXTRA_PARAMS_REQUIRED:
        if flag not in text("ExtraParams").split():
            bad(f"<ExtraParams> must contain {flag}")
    if text("WebUI") != "":
        bad("the template must not define a WebUI: the container is API-only")
    if urlparse(text("TemplateURL")).path.rsplit("/main/", 1)[-1] != "unraid/rea-mcp.xml":
        bad("<TemplateURL> must be the raw URL of unraid/rea-mcp.xml on main")

    # --- the icon the template points at must be the one in the repository
    icon_path = urlparse(text("Icon")).path
    if not icon_path.endswith("/main/" + ICON_REL.as_posix()):
        bad(f"<Icon> must be the raw URL of {ICON_REL.as_posix()} on main")
    errors.extend(png_errors(root / ICON_REL))

    # --- <Config> entries
    configs = top.findall("Config")
    by_target: dict[str, ET.Element] = {}
    for index, cfg in enumerate(configs, start=1):
        label = cfg.get("Name") or f"entry {index}"
        for attr in CONFIG_ATTRS:
            if cfg.get(attr) is None:
                bad(f"<Config> {label!r} has no {attr} attribute")
        target = cfg.get("Target") or ""
        if target in by_target:
            bad(f"<Config> Target {target!r} appears twice")
        by_target[target] = cfg
    value = lambda cfg: (cfg.text or "").strip()  # noqa: E731

    port = by_target.get("8080")
    if port is None:
        bad("there is no <Config> for port 8080")
    else:
        if port.get("Type") != "Port" or port.get("Mode") != "tcp":
            bad("the port entry must have Type=Port and Mode=tcp")
        if port.get("Required") != "true":
            bad("the port entry must be Required")

    key = by_target.get("REA_MCP_API_KEY")
    if key is None:
        bad("there is no <Config> for REA_MCP_API_KEY")
    else:
        if key.get("Type") != "Variable":
            bad("REA_MCP_API_KEY must have Type=Variable")
        if key.get("Default") != "" or value(key) != "":
            bad("REA_MCP_API_KEY must have an empty default and an empty value")
        if key.get("Mask") != "true":
            bad('REA_MCP_API_KEY must have Mask="true"')
        if key.get("Required") != "true":
            bad('REA_MCP_API_KEY must have Required="true"')
        description = (key.get("Description") or "").lower()
        if "random" not in description or "32" not in description:
            bad("the REA_MCP_API_KEY description must tell the user to generate a long random key of at least 32 characters")

    samples = by_target.get("/samples")
    if samples is None:
        bad("there is no <Config> for /samples")
    else:
        if samples.get("Type") != "Path" or samples.get("Mode") != "ro":
            bad('/samples must have Type=Path and Mode="ro"')
        if samples.get("Default") != "" or value(samples) != "":
            bad("/samples must have no default")
        if samples.get("Required") != "true":
            bad('/samples must have Required="true"')

    work = by_target.get("/work")
    if work is None:
        bad("there is no <Config> for /work")
    else:
        if work.get("Type") != "Path" or work.get("Mode") != "rw":
            bad('/work must have Type=Path and Mode="rw"')
        if work.get("Default") != APPDATA_DEFAULT or value(work) != APPDATA_DEFAULT:
            bad(f"/work must default to {APPDATA_DEFAULT}")

    # --- advanced variables, and their agreement with the gateway
    try:
        defaults = gateway_defaults(root)
    except (ValueError, OSError) as exc:
        defaults = {}
        bad(str(exc))
    if defaults and port is not None and port.get("Default") != defaults["PORT"]:
        bad(f"the port default {port.get('Default')!r} differs from the gateway's PORT default {defaults['PORT']!r}")
    for name in ADVANCED:
        cfg = by_target.get(name)
        if cfg is None:
            bad(f"there is no <Config> for the advanced variable {name}")
            continue
        if cfg.get("Type") != "Variable":
            bad(f"{name} must have Type=Variable")
        if cfg.get("Display") not in ("advanced", "advanced-hide"):
            bad(f'{name} must be shown only in the advanced view (Display="advanced"), not {cfg.get("Display")!r}')
        if defaults and cfg.get("Default") != defaults[name]:
            bad(f"{name}: the template default {cfg.get('Default')!r} differs from the gateway's {defaults[name]!r}")
        if cfg.get("Default") is not None and value(cfg) != cfg.get("Default"):
            bad(f"{name}: the value {value(cfg)!r} differs from its default {cfg.get('Default')!r}")

    checkpoint = by_target.get("REA_GHIDRA_CHECKPOINT_DIR")
    if checkpoint is not None:
        if checkpoint.get("Default") != "" or value(checkpoint) != "":
            bad("REA_GHIDRA_CHECKPOINT_DIR must default to empty, so checkpointing is off")
        description = checkpoint.get("Description") or ""
        if "/work/checkpoints" not in description:
            bad("the REA_GHIDRA_CHECKPOINT_DIR description must name /work/checkpoints")
        if not re.search(r"fail to open", description):
            bad("the REA_GHIDRA_CHECKPOINT_DIR description must say that non-stock targets fail to open")

    # --- no secrets or site-specific values
    whole = ET.tostring(top, encoding="unicode")
    for secretish in re.findall(r"[0-9a-fA-F]{32,}|[A-Za-z0-9+_-]{40,}={0,2}", whole):
        bad(f"the template holds a long key-like string ({len(secretish)} characters)")
    if re.search(r"BEGIN [A-Z ]*PRIVATE KEY", whole):
        bad("the template holds a private key")
    for cfg in configs:
        if cfg.get("Mask") == "true" and (cfg.get("Default") or value(cfg)):
            bad(f"{cfg.get('Name')!r} is masked, so it must have an empty default and value")
    for url in re.findall(r"https?://[^\s\"'<>]+", whole):
        if urlparse(url).hostname not in ALLOWED_URL_HOSTS:
            bad(f"the template links to {urlparse(url).hostname}; only public GitHub and GHCR locations are allowed")
    for path in re.findall(r"/mnt/[^\s\"'<>,]*", whole):
        if path != APPDATA_DEFAULT:
            bad(f"the template holds the host path {path!r}; only {APPDATA_DEFAULT} is allowed")
    return errors


# --- the seeded-violation test -------------------------------------------------------------------------
def mutations() -> list[tuple[str, str, str, str]]:
    """(name, file to change, text to find, replacement): each makes the template (or its surroundings) invalid."""
    # A random, key-shaped string made fresh on every run, so no literal that looks like a key is committed.
    fake_key = secrets.token_hex(32)
    t, c, i = "unraid/rea-mcp.xml", "src/config.ts", "unraid/icon.png"
    return [
        ("malformed XML", t, "</Container>", ""),
        ("wrong root version", t, '<Container version="2">', '<Container version="1">'),
        ("missing Icon element", t, "  <Icon>https://raw.githubusercontent.com/EGuthrieWasTaken/rea-mcp/main/unraid/icon.png</Icon>\n", ""),
        ("empty Support element", t, "<Support>https://github.com/EGuthrieWasTaken/rea-mcp/issues</Support>", "<Support></Support>"),
        ("uppercase in Repository", t, "ghcr.io/eguthriewastaken/rea-mcp:latest</Repository>", "ghcr.io/EGuthrieWasTaken/rea-mcp:latest</Repository>"),
        ("wrong Category", t, "<Category>Tools:</Category>", "<Category>Tools:System</Category>"),
        ("TemplateURL on another branch", t, "/main/unraid/rea-mcp.xml</TemplateURL>", "/dev/unraid/rea-mcp.xml</TemplateURL>"),
        ("Privileged true", t, "<Privileged>false</Privileged>", "<Privileged>true</Privileged>"),
        ("Network host", t, "<Network>bridge</Network>", "<Network>host</Network>"),
        ("ExtraParams without --cap-drop=ALL", t, "--security-opt=no-new-privileges:true --cap-drop=ALL", "--security-opt=no-new-privileges:true"),
        ("a WebUI", t, "  <Category>", "  <WebUI>http://[IP]:[PORT:8080]/</WebUI>\n  <Category>"),
        ("API key with a default", t, 'Target="REA_MCP_API_KEY" Default=""', f'Target="REA_MCP_API_KEY" Default="{fake_key}"'),
        ("API key not masked", t, 'Display="always" Required="true" Mask="true"></Config>', 'Display="always" Required="true" Mask="false"></Config>'),
        ("API key not required", t, 'Display="always" Required="true" Mask="true"></Config>', 'Display="always" Required="false" Mask="true"></Config>'),
        ("/samples writable", t, 'Default="" Mode="ro"', 'Default="" Mode="rw"'),
        ("/samples with a default path", t, 'Target="/samples" Default=""', 'Target="/samples" Default="/mnt/user/media"'),
        ("/work with another default", t, 'Default="/mnt/user/appdata/rea-mcp" Mode="rw"', 'Default="/mnt/user/appdata/other" Mode="rw"'),
        ("a Config without Mask", t, 'Display="advanced" Required="false" Mask="false">info</Config>', 'Display="advanced" Required="false">info</Config>'),
        ("an advanced variable removed", t, 'Target="LOG_LEVEL"', 'Target="LOG_LEVEL_UNUSED"'),
        ("an advanced variable not advanced", t, 'Display="advanced" Required="false" Mask="false">4</Config>', 'Display="always" Required="false" Mask="false">4</Config>'),
        ("template default differs from the gateway (template side)", t, 'Target="MAX_SESSIONS" Default="4"', 'Target="MAX_SESSIONS" Default="9"'),
        ("template default differs from the gateway (gateway side)", c, 'MAX_SESSIONS: "4"', 'MAX_SESSIONS: "8"'),
        ("checkpointing on by default", t, 'Target="REA_GHIDRA_CHECKPOINT_DIR" Default=""', 'Target="REA_GHIDRA_CHECKPOINT_DIR" Default="/work/checkpoints"'),
        ("checkpoint description without /work/checkpoints", t, "Set to /work/checkpoints to keep", "Set to a folder to keep"),
        ("checkpoint description without the warning", t, "fail to open with Ghidra", "do not work"),
        ("a link to another host", t, "https://github.com/EGuthrieWasTaken/rea-mcp</Project>", "https://example.invalid/rea-mcp</Project>"),
        ("a user-specific host path", t, "for example the tunnel's host name.", "for example /mnt/disk1/private."),
        ("the icon is not a PNG", i, "", "TRUNCATE"),
        ("the icon has a bad CRC", i, "", "FLIP"),
        ("the icon is animated", i, "", "APNG"),
        ("the icon is missing", i, "", "REMOVE"),
    ]


def self_test() -> int:
    """Each seeded violation must be rejected, and the pristine template accepted."""
    failures = 0
    pristine = check(ROOT)
    if pristine:
        print("self-test: the unmodified template is rejected, so the test cannot start:", *pristine, sep="\n  ", file=sys.stderr)
        return 1
    print("self-test: ok: the unmodified template is accepted")
    for name, rel, find, replace in mutations():
        with tempfile.TemporaryDirectory(prefix="rea-mcp-template-check.") as tmp:
            scratch = Path(tmp)
            for source in (TEMPLATE_REL, ICON_REL, CONFIG_TS_REL):
                (scratch / source).parent.mkdir(parents=True, exist_ok=True)
                (scratch / source).write_bytes((ROOT / source).read_bytes())
            target = scratch / rel
            if rel == ICON_REL.as_posix():
                data = target.read_bytes()
                if replace == "TRUNCATE":
                    target.write_bytes(data[:40])
                elif replace == "FLIP":
                    target.write_bytes(data[:50] + bytes([data[50] ^ 0xFF]) + data[51:])
                elif replace == "APNG":
                    chunk = struct.pack(">I", 8) + b"acTL" + struct.pack(">II", 1, 0)
                    chunk += struct.pack(">I", zlib.crc32(b"acTL" + struct.pack(">II", 1, 0)) & 0xFFFFFFFF)
                    target.write_bytes(data[:33] + chunk + data[33:])  # right after IHDR
                elif replace == "REMOVE":
                    target.unlink()
            else:
                original = target.read_text(encoding="utf-8")
                if original.count(find) != 1:
                    print(f"self-test: FAIL: {name}: the text to change occurs {original.count(find)} times, not once", file=sys.stderr)
                    failures += 1
                    continue
                target.write_text(original.replace(find, replace), encoding="utf-8")
            found = check(scratch)
            if found:
                print(f"self-test: ok: rejected: {name}  ->  {found[0][:110]}")
            else:
                print(f"self-test: FAIL: accepted a template with this violation: {name}", file=sys.stderr)
                failures += 1

    # The command-line tool itself must exit 1 on a broken copy and 0 on the real one.
    with tempfile.TemporaryDirectory(prefix="rea-mcp-template-check.") as tmp:
        broken = Path(tmp) / "broken.xml"
        broken.write_text((ROOT / TEMPLATE_REL).read_text(encoding="utf-8").replace("<Category>Tools:</Category>", ""), encoding="utf-8")
        run = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--template", str(broken)], capture_output=True, text=True)
        if run.returncode == 1 and "Category" in run.stderr:
            print("self-test: ok: the command exits 1, naming the problem, on a broken copy")
        else:
            print(f"self-test: FAIL: the command exited {run.returncode} on a broken copy", file=sys.stderr)
            failures += 1
    if failures:
        print(f"self-test: {failures} failure(s)", file=sys.stderr)
        return 1
    print("self-test: all seeded violations were rejected")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--template", type=Path, help="check this file instead of unraid/rea-mcp.xml")
    parser.add_argument("--self-test", action="store_true", help="seed deliberate violations and require each to be rejected")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    errors = check(ROOT, args.template)
    for message in errors:
        print(f"template: {message}", file=sys.stderr)
    if errors:
        print(f"template: {len(errors)} problem(s)", file=sys.stderr)
        return 1
    print("template: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
