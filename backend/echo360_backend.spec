from pathlib import Path
import os
import sys

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)


repo_root = Path(os.environ["ECHO360_REPO_ROOT"]).resolve()
assets_dir = Path(os.environ["ECHO360_BACKEND_ASSETS_DIR"]).resolve()

datas = []
binaries = []
hiddenimports = []

# Argos and Uvicorn load some modules dynamically. Limit explicit collection to
# runtime modules and package data; their standard PyInstaller hooks collect the
# heavy native dependencies without dragging third-party test suites into the
# release artifact.
for package_name in ("argostranslate", "minisbd"):
    datas += collect_data_files(package_name)
    hiddenimports += collect_submodules(
        package_name,
        filter=lambda name: ".tests" not in name and not name.endswith(".tests"),
    )

hiddenimports += collect_submodules(
    "uvicorn",
    filter=lambda name: ".tests" not in name and not name.endswith(".tests"),
)
binaries += collect_dynamic_libs("ctranslate2")
binaries += collect_dynamic_libs("sentencepiece")
binaries += collect_dynamic_libs("onnxruntime")
datas += collect_data_files("certifi")
datas += collect_data_files("onnxruntime")
hiddenimports += ["onnxruntime.capi._pybind_state"]

for package_name in (
    "argostranslate",
    "ctranslate2",
    "minisbd",
    "numpy",
    "onnxruntime",
    "sacremoses",
    "sentencepiece",
    "spacy",
    "stanza",
    "uvicorn",
):
    datas += copy_metadata(package_name)

datas += [
    (str(assets_dir), "backend_assets"),
    (str(repo_root / "LICENSE"), "."),
    (str(repo_root / "THIRD_PARTY_NOTICES.md"), "."),
]

analysis = Analysis(
    [str(repo_root / "backend" / "launcher.py")],
    pathex=[str(repo_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "langcodes.tests",
        "spacy.tests",
        "stanza.tests",
        "thinc.tests",
        "torch.tests",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="echo360-subtitle-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    # Finder/browser URL opens are delivered as argv values on macOS.  Keep
    # the launch URL available to backend.launcher so it can be discarded
    # before argparse processes normal server flags.
    argv_emulation=True,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Echo360SubtitleBackend",
)

if sys.platform == "darwin":
    application = BUNDLE(
        collection,
        name="Echo360 Subtitle Backend.app",
        icon=None,
        bundle_identifier="io.github.realtim.echo360-subtitle-backend",
        info_plist={
            "CFBundleDisplayName": "Echo360 Subtitle Backend",
            "CFBundleName": "Echo360 Subtitle Backend",
            "LSMinimumSystemVersion": "12.0",
            "CFBundleURLTypes": [
                {
                    "CFBundleTypeRole": "Viewer",
                    "CFBundleURLName": "io.github.realtim.echo360-subtitle-backend",
                    "CFBundleURLSchemes": ["echo360-subtitle-backend"],
                }
            ],
        },
    )
