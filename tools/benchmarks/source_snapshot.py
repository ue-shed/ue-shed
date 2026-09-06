"""Copy benchmark inputs without importing ignored build products or local state."""

from pathlib import Path
import shutil
import subprocess


def copy_source_snapshot(root: Path, output: Path) -> None:
    """Preserve working-tree edits and new source files, respecting Git exclusions."""
    root = root.resolve()
    output = output.resolve()
    paths = subprocess.check_output(
        [
            "git", "ls-files", "-z", "--cached", "--others", "--exclude-standard",
            "--", "Cargo.toml", "Cargo.lock", "crates", "fixtures",
            "packages/protocol/contracts",
        ],
        cwd=root,
    )
    sources = []
    for name in sorted(set(paths.split(b"\0")) - {b""}):
        relative = Path(name.decode("utf-8"))
        source = root / relative
        # Never dereference links/junctions into another workspace or a build cache.
        if any(p.is_symlink() or p.is_junction() for p in [source, *source.parents]
               if p != root and root in p.parents):
            raise ValueError(f"Snapshot input contains a link: {relative}")
        if not source.exists():
            continue  # A tracked file deleted in the working tree stays deleted.
        if not source.is_file() or not source.resolve().is_relative_to(root):
            raise ValueError(f"Snapshot input is not a regular repository file: {relative}")
        sources.append((source, relative))
    output.mkdir(parents=True, exist_ok=False)
    for source, relative in sources:
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
