from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIST_ROOT = REPO_ROOT / "dist" / "backend"
SAMPLE_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello world\n"


def packaged_executable(dist_root: Path) -> Path:
    if platform.system() == "Darwin":
        return dist_root / "Echo360 Subtitle Backend.app" / "Contents" / "MacOS" / "echo360-subtitle-backend"
    executable_name = "echo360-subtitle-backend.exe" if platform.system() == "Windows" else "echo360-subtitle-backend"
    return dist_root / "Echo360SubtitleBackend" / executable_name


def unused_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def check_health(executable: Path, env: dict[str, str]) -> None:
    port = unused_local_port()
    process = subprocess.Popen(
        [str(executable), "--port", str(port), "--log-level", "warning"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    try:
        deadline = time.monotonic() + 60
        url = f"http://127.0.0.1:{port}/health"
        while True:
            if process.poll() is not None:
                raise RuntimeError(f"Packaged backend exited early with code {process.returncode}")
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                if payload == {"ok": True}:
                    return
                raise RuntimeError(f"Unexpected health response: {payload!r}")
            except (OSError, ValueError):
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Packaged backend did not become healthy at {url}")
                time.sleep(0.25)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def check_translator_dispatch(executable: Path, env: dict[str, str]) -> None:
    subprocess.run(
        [str(executable), "--translator", "--help"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=60,
        env=env,
    )


def check_argos_translation(executable: Path, env: dict[str, str]) -> None:
    with tempfile.TemporaryDirectory(prefix="echo360-packaged-smoke-") as temp_dir:
        root = Path(temp_dir)
        source = root / "source.vtt"
        output = root / "translated.vtt"
        source.write_text(SAMPLE_VTT, encoding="utf-8")
        subprocess.run(
            [
                str(executable),
                "--translator",
                str(source),
                "--out",
                str(output),
                "--provider",
                "argos",
                "--target",
                "ZH",
            ],
            check=True,
            timeout=240,
            env=env,
        )
        translated = output.read_text(encoding="utf-8")
        if translated == SAMPLE_VTT or "Hello world" in translated:
            raise RuntimeError("Packaged Argos smoke test returned the untranslated source text")


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a packaged Echo360 backend")
    parser.add_argument("--dist-root", type=Path, default=DEFAULT_DIST_ROOT)
    parser.add_argument("--check-argos", action="store_true")
    args = parser.parse_args()
    executable = packaged_executable(args.dist_root.resolve())
    if not executable.is_file():
        raise FileNotFoundError(f"Packaged backend executable not found: {executable}")

    with tempfile.TemporaryDirectory(prefix="echo360-packaged-runtime-") as runtime_dir:
        env = dict(os.environ)
        env["ECHO360_CACHE_DIR"] = str(Path(runtime_dir) / "cache")
        env["ECHO360_CONFIG_DIR"] = str(Path(runtime_dir) / "config")
        env["ECHO360_DATA_DIR"] = str(Path(runtime_dir) / "data")
        check_translator_dispatch(executable, env)
        check_health(executable, env)
        if args.check_argos:
            check_argos_translation(executable, env)
    print(f"Packaged backend smoke test passed: {executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
