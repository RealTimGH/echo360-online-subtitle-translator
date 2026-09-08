from __future__ import annotations

import json
import os
import platform
import shutil
import sys
import uuid
from pathlib import Path


APP_DIR_NAME = "Echo360 Subtitle Translator"
ASSET_DIR_NAME = "backend_assets"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_root() -> Path:
    """Return PyInstaller's read-only bundle root, or the repository root."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def bundled_assets_dir() -> Path:
    return bundle_root() / ASSET_DIR_NAME


def _user_cache_root() -> Path:
    override = os.getenv("ECHO360_CACHE_DIR", "").strip()
    if override:
        return Path(override).expanduser()

    system = platform.system()
    if system == "Windows":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / APP_DIR_NAME / "Cache"
    if system == "Darwin":
        return Path.home() / "Library" / "Caches" / APP_DIR_NAME
    base = Path(os.getenv("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "echo360-subtitle-translator"


def _user_config_root() -> Path:
    override = os.getenv("ECHO360_CONFIG_DIR", "").strip()
    if override:
        return Path(override).expanduser()

    system = platform.system()
    if system == "Windows":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / APP_DIR_NAME / "Config"
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME / "Config"
    base = Path(os.getenv("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "echo360-subtitle-translator"


def _user_data_root() -> Path:
    override = os.getenv("ECHO360_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()

    system = platform.system()
    if system == "Windows":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / APP_DIR_NAME / "Data"
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME / "Data"
    base = Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "echo360-subtitle-translator"


def _read_seed_manifest(seed_dir: Path) -> dict:
    manifest_path = seed_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Bundled Argos manifest is unreadable: {manifest_path}") from exc
    if manifest.get("schema_version") != 1 or not manifest.get("seed_id"):
        raise RuntimeError(f"Bundled Argos manifest is invalid: {manifest_path}")
    return manifest


def _seed_copy_is_complete(target_dir: Path, manifest: dict) -> bool:
    try:
        installed_manifest = json.loads((target_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if installed_manifest.get("seed_id") != manifest.get("seed_id"):
        return False
    for item in manifest.get("files", []):
        path = target_dir / str(item.get("path", ""))
        try:
            if not path.is_file() or path.stat().st_size != int(item.get("size", -1)):
                return False
        except (OSError, TypeError, ValueError):
            return False
    return True


def _materialize_argos_seed(seed_dir: Path, data_root: Path) -> Path:
    """Atomically install immutable bundled models into a writable user directory."""
    manifest = _read_seed_manifest(seed_dir)
    seed_id = str(manifest["seed_id"])
    seeds_root = data_root / "argos-seeds"
    target_dir = seeds_root / seed_id
    if _seed_copy_is_complete(target_dir, manifest):
        return target_dir

    seeds_root.mkdir(parents=True, exist_ok=True)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    temporary_dir = seeds_root / f".{seed_id}.{uuid.uuid4().hex}.tmp"
    try:
        shutil.copytree(seed_dir, temporary_dir)
        if not _seed_copy_is_complete(temporary_dir, manifest):
            raise RuntimeError("Bundled Argos assets were not copied completely")
        try:
            os.replace(temporary_dir, target_dir)
        except OSError:
            # A concurrently starting server/translator may have installed the
            # same seed between the initial check and the atomic rename.
            if not _seed_copy_is_complete(target_dir, manifest):
                raise
    finally:
        if temporary_dir.exists():
            shutil.rmtree(temporary_dir, ignore_errors=True)
    return target_dir


def configure_runtime_environment() -> None:
    """Configure writable caches and bundled Argos assets before imports occur."""
    cache_root = _user_cache_root()
    config_root = _user_config_root()
    data_root = _user_data_root()
    cache_root.mkdir(parents=True, exist_ok=True)
    config_root.mkdir(parents=True, exist_ok=True)
    data_root.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("ECHO360_CACHE_DIR", str(cache_root / "translations"))
    os.environ.setdefault("XDG_CACHE_HOME", str(cache_root / "xdg-cache"))
    os.environ.setdefault("XDG_CONFIG_HOME", str(config_root / "xdg-config"))
    os.environ.setdefault("ARGOS_CHUNK_TYPE", "MINISBD")

    assets = bundled_assets_dir()
    argos_seed = assets / "argos"
    argos_runtime = (
        _materialize_argos_seed(argos_seed, data_root)
        if (argos_seed / "manifest.json").is_file()
        else argos_seed
    )
    packages_dir = argos_runtime / "packages"
    data_home = argos_runtime / "data"
    if packages_dir.is_dir():
        os.environ.setdefault("ARGOS_PACKAGES_DIR", str(packages_dir))
    if data_home.is_dir():
        # Argos 1.11 derives the MiniSBD path from XDG_DATA_HOME at import time.
        os.environ.setdefault("XDG_DATA_HOME", str(data_home))
