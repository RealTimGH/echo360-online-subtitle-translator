import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from backend import runtime


class ArgosSeedRuntimeTests(unittest.TestCase):
    def test_concurrent_materialization_keeps_one_complete_live_copy(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            seed_dir = root / "bundle" / "argos"
            packages_dir = seed_dir / "packages"
            packages_dir.mkdir(parents=True)
            model = packages_dir / "model.bin"
            model.write_bytes(b"model-data")
            manifest = {
                "schema_version": 1,
                "seed_id": "seed-concurrency-test",
                "files": [{"path": "packages/model.bin", "size": len(b"model-data")}],
            }
            (seed_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            data_root = root / "user-data"
            barrier = threading.Barrier(4)

            def install():
                barrier.wait()
                return runtime._materialize_argos_seed(seed_dir, data_root)

            with ThreadPoolExecutor(max_workers=4) as executor:
                installed = list(executor.map(lambda _: install(), range(4)))

            self.assertTrue(all(path == installed[0] for path in installed))
            self.assertTrue(runtime._seed_copy_is_complete(installed[0], manifest))
            self.assertEqual((installed[0] / "packages" / "model.bin").read_bytes(), b"model-data")
            self.assertFalse(any(installed[0].parent.glob("*.install.lock")))


if __name__ == "__main__":
    unittest.main()
