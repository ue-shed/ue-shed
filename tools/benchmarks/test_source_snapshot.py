"""Regression coverage using a real Git working tree and generated fixture files."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from source_snapshot import copy_source_snapshot


class SourceSnapshotTests(unittest.TestCase):
    def test_snapshot_excludes_builds_and_preserves_working_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            subprocess.run(["git", "init", "-q", str(root)], check=True)

            def write(name, content="fixture"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)

            write(".gitignore", "**/target/\n**/Intermediate/\n**/Binaries/\n**/Saved/\n")
            write("Cargo.toml", "original")
            write("fixtures/content/keep.uasset")
            write("fixtures/deleted.txt")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            with (root / ".gitignore").open("a") as ignores:
                ignores.write("fixtures/content/\n")
            write("Cargo.toml", "edited")
            (root / "fixtures/deleted.txt").unlink()
            write("crates/new source.rs", "new source")
            write("fixtures/unreal-project/Intermediate/Build/SharedPCH.pch")
            write("fixtures/unreal-project/Binaries/fixture.dll")
            write("fixtures/unreal-project/Saved/local-state.json")
            write("crates/wasm/target/debug/build.bin")
            write("unrelated.txt")
            output = Path(temporary) / "snapshot"
            copy_source_snapshot(root, output)
            self.assertEqual(
                {p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()},
                {"Cargo.toml", "fixtures/content/keep.uasset", "crates/new source.rs"},
            )
            self.assertEqual((output / "Cargo.toml").read_text(), "edited")
            with self.assertRaises(FileExistsError):
                copy_source_snapshot(root, output)

    def test_snapshot_rejects_linked_inputs_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "fixtures").mkdir()
            outside = Path(temporary) / "outside.bin"
            outside.write_text("must not be copied")
            try:
                (root / "fixtures/linked.bin").symlink_to(outside)
            except OSError as error:
                self.skipTest(f"Symlink creation is unavailable: {error}")
            output = Path(temporary) / "snapshot"
            with self.assertRaisesRegex(ValueError, "contains a link"):
                copy_source_snapshot(root, output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
