"""Build Marge and synchronize its generated GitHub Pages files at repository root.

Sources remain in dist/. Only the named runtime files and generated icons/ tree
are copied. Personal imports, exports and payroll documents are never collected.
Run from any directory with Python 3; no third-party dependency is required.
"""
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
RUNTIME_FILES = ("index.html", "manifest.webmanifest", "sw.js", "pwa.js")


def main():
    subprocess.run([sys.executable, str(ROOT / "build.py")], cwd=ROOT, check=True)
    missing = [name for name in RUNTIME_FILES if not (DIST / name).is_file()]
    icons_source = DIST / "icons"
    if missing or not icons_source.is_dir():
        missing += [] if icons_source.is_dir() else ["icons/"]
        raise SystemExit("Publication impossible : fichiers absents dans dist/ : " + ", ".join(missing))

    icon_files = sorted(path for path in icons_source.rglob("*") if path.is_file())
    if not icon_files:
        raise SystemExit("Publication impossible : dist/icons/ est vide.")
    if any(path.is_symlink() for path in icon_files):
        raise SystemExit("Publication impossible : les icônes doivent être des fichiers locaux ordinaires.")

    for name in RUNTIME_FILES:
        shutil.copyfile(DIST / name, ROOT / name)

    icons_target = ROOT / "icons"
    if icons_target.is_symlink():
        raise SystemExit("Publication impossible : icons/ ne doit pas être un lien symbolique.")
    icons_target.mkdir(exist_ok=True)
    expected = {path.relative_to(icons_source) for path in icon_files}
    for source in icon_files:
        target = icons_target / source.relative_to(icons_source)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            raise SystemExit("Publication impossible : une icône cible est un lien symbolique.")
        shutil.copyfile(source, target)
    # icons/ at root is generated: remove obsolete assets after copying the new set.
    for target in sorted(icons_target.rglob("*"), reverse=True):
        if target.is_file() and target.relative_to(icons_target) not in expected:
            target.unlink()
        elif target.is_dir() and not any(target.iterdir()):
            target.rmdir()

    (ROOT / ".nojekyll").touch()
    print("GitHub Pages : fichiers racine synchronisés depuis dist/ (main / root).")


if __name__ == "__main__":
    main()
