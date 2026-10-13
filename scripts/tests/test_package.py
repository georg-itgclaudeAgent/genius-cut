"""package.py's assistant gating: editor packages never carry the Claude assistant."""

import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import package as pkg  # noqa: E402

MANIFEST = ('<ExtensionManifest ExtensionBundleId="com.attract.genius-cut" '
            'ExtensionBundleVersion="1.2.3"></ExtensionManifest>')


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A minimal genius-cut checkout in a temp dir, with package.py pointed at it."""
    ext = tmp_path / "extension"
    (ext / "CSXS").mkdir(parents=True)
    (ext / "CSXS" / "manifest.xml").write_text(MANIFEST, encoding="utf-8")
    (ext / "host").mkdir()
    (ext / "host" / "index.jsx").write_text("function gcutApply() {}", encoding="utf-8")
    (ext / "host" / "assistant.jsx").write_text("function gcutToolGetSequence() {}", encoding="utf-8")
    dist = ext / "client" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    (dist / "assets" / "index-abc.js").write_text("console.log('panel')", encoding="utf-8")
    (tmp_path / "mcp").mkdir()
    (tmp_path / "mcp" / "premiere-mcp.mjs").write_text("// mcp", encoding="utf-8")
    (tmp_path / "backend").mkdir()
    monkeypatch.setattr(pkg, "ROOT", tmp_path)
    monkeypatch.setattr(pkg, "EXT", ext)
    monkeypatch.setattr(pkg, "BACKEND", tmp_path / "backend")
    return tmp_path


def _flag(repo, rel="assets/index-abc.js", data=b'h.setHeader("X-Genius-Cut","gcut-assistant-bridge")'):
    p = repo / "extension" / "client" / "dist" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def test_a_default_dist_passes_the_checks(repo):
    pkg.check("1.2.3")  # no SystemExit


def test_a_dist_with_the_bridge_marker_is_refused(repo, capsys):
    _flag(repo)
    with pytest.raises(SystemExit) as e:
        pkg.check("1.2.3")
    assert e.value.code == 1
    err = capsys.readouterr().err
    assert "gcut-assistant-bridge" in err and "VITE_GENIUSCUT_CLAUDE" in err
    assert "assets/index-abc.js" in err


@pytest.mark.parametrize("rel", ["index.html", "assets/deep/chunk.js.map", "assets/blob.bin"])
def test_the_marker_is_found_in_any_file_under_dist(repo, rel):
    _flag(repo, rel, b"\x00\x01prefix gcut-assistant-bridge suffix\xff")
    with pytest.raises(SystemExit):
        pkg.check("1.2.3")


def test_main_check_mode_refuses_a_flagged_dist_too(repo, monkeypatch):
    _flag(repo)
    monkeypatch.setattr(sys, "argv", ["package.py", "1.2.3", "--check"])
    with pytest.raises(SystemExit):
        pkg.main()


def test_assistant_jsx_is_never_listed(repo):
    names = [arc for _, arc in pkg.files(include_backend=True)]
    assert "host/index.jsx" in names
    assert "host/assistant.jsx" not in names
    assert not any(n.startswith("mcp/") or "premiere-mcp" in n for n in names)


def test_assistant_jsx_is_never_zipped(repo):
    out = pkg.build("1.2.3", include_backend=False)
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    assert "host/index.jsx" in names and "client/dist/index.html" in names
    assert "host/assistant.jsx" not in names
    assert not any("premiere-mcp" in n for n in names)
