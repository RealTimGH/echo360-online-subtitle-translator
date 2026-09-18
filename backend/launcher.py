from __future__ import annotations

import argparse
import ipaddress
import platform
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.runtime import (
    URL_SCHEME,
    configure_runtime_environment,
    parse_backend_url,
    register_windows_url_scheme,
)


TRANSLATOR_MODE = "--translator"
REGISTER_URL_SCHEME_MODE = "--register-url-scheme"


def is_loopback_host(host: str) -> bool:
    normalized = str(host or "").strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def strip_protocol_url_args(arguments: list[str]) -> list[str]:
    """Remove OS-delivered backend URLs before argparse sees the arguments."""
    return [argument for argument in arguments if parse_backend_url(argument) is None]


def _register_url_scheme_and_exit() -> int:
    registered = register_windows_url_scheme()
    # macOS uses the application bundle's Info.plist rather than a registry;
    # the flag remains a successful no-op there so shared launch scripts can
    # call it without branching on the host OS.
    if platform.system() != "Windows":
        return 0
    if registered:
        print(f"Registered {URL_SCHEME}:// URL scheme for the current user.")
        return 0
    print("Could not register the Echo360 backend URL scheme.", file=sys.stderr)
    return 1


def run_translator(arguments: list[str]) -> int:
    from translator import translate_vtt_zh_deepl_native

    sys.argv = [sys.argv[0], *arguments]
    return int(translate_vtt_zh_deepl_native.main())


def run_server(arguments: list[str]) -> int:
    arguments = strip_protocol_url_args(arguments)
    parser = argparse.ArgumentParser(
        prog="echo360-subtitle-backend",
        description="Local backend for Echo360 Online Subtitle Translator",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Listen address (default: 127.0.0.1)")
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        help="Explicitly allow an unauthenticated non-loopback listener (unsafe; use only behind a trusted authenticated proxy)",
    )
    parser.add_argument("--port", default=8765, type=int, help="Listen port (default: 8765)")
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
    )
    args = parser.parse_args(arguments)

    if not is_loopback_host(args.host) and not args.allow_remote:
        parser.error(
            "refusing an unauthenticated non-loopback listener; keep --host on loopback "
            "or explicitly pass --allow-remote behind a trusted authenticated proxy"
        )

    # Windows cannot receive a browser URL until a handler exists.  Register
    # on every ordinary server start as a repair path for moved/extracted apps.
    register_windows_url_scheme()

    import uvicorn
    from backend.app import app

    # On macOS the native AppKit executable starts this PyInstaller binary as
    # a child and captures its stdout/stderr. Keeping the Python process as a
    # normal Uvicorn core avoids embedding a second GUI event loop and keeps
    # the same server path for CLI, Windows, tests, and the native host.
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


def main(arguments: list[str] | None = None) -> int:
    args = strip_protocol_url_args(list(sys.argv[1:] if arguments is None else arguments))
    if REGISTER_URL_SCHEME_MODE in args:
        return _register_url_scheme_and_exit()
    configure_runtime_environment()
    if args and args[0] == TRANSLATOR_MODE:
        return run_translator(args[1:])
    return run_server(args)


if __name__ == "__main__":
    raise SystemExit(main())
