from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_ROOT = REPO_ROOT / "build" / "backend"
ASSETS_ROOT = BUILD_ROOT / "assets"
DIST_ROOT = REPO_ROOT / "dist"
PYINSTALLER_DIST = DIST_ROOT / "backend"
PYINSTALLER_WORK = BUILD_ROOT / "pyinstaller"
DEFAULT_ARGOS_TARGETS = ("zh", "zt")
WINDOWS_BACKEND_EXECUTABLE = "echo360-subtitle-backend.exe"
WINDOWS_INSTALL_SCRIPT_NAME = "install-and-launch-echo360-subtitle-backend.cmd"
BACKEND_URL_SCHEME = "echo360-subtitle-backend"


def normalized_platform_name() -> str:
    return {"Darwin": "macos", "Windows": "windows"}.get(platform.system(), platform.system().lower())


def normalized_architecture() -> str:
    machine = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(machine, machine)


def argos_environment() -> dict[str, str]:
    argos_root = ASSETS_ROOT / "argos"
    env = dict(os.environ)
    env.update(
        {
            "ARGOS_PACKAGES_DIR": str(argos_root / "packages"),
            "ARGOS_CHUNK_TYPE": "MINISBD",
            "XDG_DATA_HOME": str(argos_root / "data"),
            "XDG_CACHE_HOME": str(BUILD_ROOT / "argos-cache"),
            "XDG_CONFIG_HOME": str(BUILD_ROOT / "argos-config"),
        }
    )
    return env


def installed_argos_pairs(packages_dir: Path) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    if not packages_dir.is_dir():
        return pairs
    for metadata_path in packages_dir.glob("*/metadata.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if metadata.get("type", "translate") == "translate":
            pairs.add((str(metadata.get("from_code", "")), str(metadata.get("to_code", ""))))
    return pairs


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_argos_manifest(targets: tuple[str, ...]) -> None:
    argos_root = ASSETS_ROOT / "argos"
    manifest_path = argos_root / "manifest.json"
    files = []
    for path in sorted(item for item in argos_root.rglob("*") if item.is_file() and item != manifest_path):
        files.append(
            {
                "path": path.relative_to(argos_root).as_posix(),
                "size": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    identity_payload = json.dumps(
        {"schema_version": 1, "targets": list(targets), "files": files},
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    manifest = {
        "schema_version": 1,
        "seed_id": hashlib.sha256(identity_payload).hexdigest()[:20],
        "targets": list(targets),
        "files": files,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def prepare_argos_assets(targets: tuple[str, ...], refresh: bool) -> None:
    if refresh:
        shutil.rmtree(ASSETS_ROOT / "argos", ignore_errors=True)
        shutil.rmtree(BUILD_ROOT / "argos-cache", ignore_errors=True)
        shutil.rmtree(BUILD_ROOT / "argos-config", ignore_errors=True)
    env = argos_environment()
    packages_dir = Path(env["ARGOS_PACKAGES_DIR"])
    minisbd_model = Path(env["XDG_DATA_HOME"]) / "argos-translate" / "minisbd" / "en.onnx"
    packages_dir.mkdir(parents=True, exist_ok=True)

    missing_targets = [target for target in targets if ("en", target) not in installed_argos_pairs(packages_dir)]
    if refresh or missing_targets:
        code = """
from argostranslate import package

targets = set(__import__('json').loads(__import__('os').environ['ECHO360_ARGOS_TARGETS']))
package.update_package_index()
available = package.get_available_packages()
for target in sorted(targets):
    match = next(
        (
            item for item in available
            if item.type == 'translate' and item.from_code == 'en' and item.to_code == target
        ),
        None,
    )
    if match is None:
        raise SystemExit(f'No Argos package is available for en->{target}')
    match.install()
"""
        model_env = dict(env)
        model_env["ECHO360_ARGOS_TARGETS"] = json.dumps(missing_targets or list(targets))
        subprocess.run([sys.executable, "-c", code], check=True, env=model_env, cwd=REPO_ROOT)

    if refresh or not minisbd_model.is_file():
        code = "from argostranslate import sbd; sbd.minisbd_models.download_models(['en'])"
        subprocess.run([sys.executable, "-c", code], check=True, env=env, cwd=REPO_ROOT)

    missing_after = [target for target in targets if ("en", target) not in installed_argos_pairs(packages_dir)]
    if missing_after or not minisbd_model.is_file():
        raise RuntimeError(f"Argos assets are incomplete; missing targets={missing_after}, minisbd={minisbd_model}")

    for metadata_path in packages_dir.glob("*/metadata.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pair = (str(metadata.get("from_code", "")), str(metadata.get("to_code", "")))
        if pair[0] == "en" and pair[1] not in targets:
            shutil.rmtree(metadata_path.parent)
    write_argos_manifest(targets)


def write_windows_install_script(package_dir: Path) -> Path:
    """Add a one-time, no-elevation URL-handler installer to a Windows build."""
    script_path = package_dir / WINDOWS_INSTALL_SCRIPT_NAME
    script = f"""@echo off
setlocal EnableExtensions
set "BACKEND_EXE=%~dp0{WINDOWS_BACKEND_EXECUTABLE}"
set "BACKEND_URL={BACKEND_URL_SCHEME}://start"

if not exist "%BACKEND_EXE%" (
  echo Backend executable not found: "%BACKEND_EXE%"
  exit /b 1
)

echo Registering the {BACKEND_URL_SCHEME}:// URL scheme for the current user...
"%BACKEND_EXE%" --register-url-scheme
if errorlevel 1 (
  echo URL scheme registration failed.
  exit /b 1
)

echo Starting the Echo360 Subtitle Backend...
start "" "%BACKEND_EXE%" "%BACKEND_URL%"
endlocal
"""
    # Keep the generated file native to Windows even when an archive is
    # assembled by a tool that normalizes text line endings.
    script_path.write_bytes(script.replace("\n", "\r\n").encode("utf-8"))
    return script_path


def archive_output() -> Path:
    system = normalized_platform_name()
    arch = normalized_architecture()
    base_name = f"echo360-online-subtitle-translator-backend-{system}-{arch}"
    if platform.system() == "Darwin":
        source = PYINSTALLER_DIST / "Echo360 Subtitle Backend.app"
        archive = DIST_ROOT / f"{base_name}.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            output.add(source, arcname=source.name, recursive=True)
        return archive

    source = PYINSTALLER_DIST / "Echo360SubtitleBackend"
    if platform.system() == "Windows":
        write_windows_install_script(source)
    archive_base = DIST_ROOT / base_name
    return Path(shutil.make_archive(str(archive_base), "zip", root_dir=source.parent, base_dir=source.name))


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the standalone Echo360 subtitle backend")
    parser.add_argument(
        "--argos-target",
        action="append",
        dest="argos_targets",
        help="Argos target code to bundle; may be repeated (default: zh and zt)",
    )
    parser.add_argument("--refresh-models", action="store_true", help="Redownload configured Argos models")
    parser.add_argument(
        "--without-models",
        action="store_true",
        help="Build the runtime without Argos model data (intended only for packaging diagnostics)",
    )
    args = parser.parse_args()
    targets = tuple(dict.fromkeys(args.argos_targets or DEFAULT_ARGOS_TARGETS))

    selected_assets_root = ASSETS_ROOT
    if not args.without_models:
        prepare_argos_assets(targets, args.refresh_models)
    else:
        selected_assets_root = BUILD_ROOT / "empty-assets"
        shutil.rmtree(selected_assets_root, ignore_errors=True)
        selected_assets_root.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["ECHO360_REPO_ROOT"] = str(REPO_ROOT)
    env["ECHO360_BACKEND_ASSETS_DIR"] = str(selected_assets_root)
    env["PYINSTALLER_CONFIG_DIR"] = str(BUILD_ROOT / "pyinstaller-config")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--clean",
            "--noconfirm",
            "--distpath",
            str(PYINSTALLER_DIST),
            "--workpath",
            str(PYINSTALLER_WORK),
            str(REPO_ROOT / "backend" / "echo360_backend.spec"),
        ],
        check=True,
        cwd=REPO_ROOT,
        env=env,
    )
    archive = archive_output()
    print(f"Built backend: {archive.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
