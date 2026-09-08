from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.runtime import configure_runtime_environment


TRANSLATOR_MODE = "--translator"


def run_translator(arguments: list[str]) -> int:
    from translator import translate_vtt_zh_deepl_native

    sys.argv = [sys.argv[0], *arguments]
    return int(translate_vtt_zh_deepl_native.main())


def run_server(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="echo360-subtitle-backend",
        description="Local backend for Echo360 Online Subtitle Translator",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Listen address (default: 127.0.0.1)")
    parser.add_argument("--port", default=8765, type=int, help="Listen port (default: 8765)")
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
    )
    args = parser.parse_args(arguments)

    import uvicorn
    from backend.app import app

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


def main(arguments: list[str] | None = None) -> int:
    configure_runtime_environment()
    args = list(sys.argv[1:] if arguments is None else arguments)
    if args and args[0] == TRANSLATOR_MODE:
        return run_translator(args[1:])
    return run_server(args)


if __name__ == "__main__":
    raise SystemExit(main())
