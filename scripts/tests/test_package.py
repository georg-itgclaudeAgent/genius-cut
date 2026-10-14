"""package.py's assistant gating: editor packages never carry the personal door to the Claude assistant
(the HTTP bridge in a flagged client build, mcp/). The host toolbox is in host/index.jsx and is packaged."""

import shutil
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import package as pkg  # noqa: E402

REAL_HOST = Path(__file__).resolve().parents[2] / "extension" / "host" / "index.jsx"

MANIFEST = ('<ExtensionManifest ExtensionBundleId="com.attract.genius-cut" '
            'ExtensionBundleVersion="1.2.3"></ExtensionManifest>')


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A minimal genius-cut checkout in a temp dir, with package.py pointed at it."""
    ext = tmp_path / "extension"
    (ext / "CSXS").mkdir(parents=True)
    (ext / "CSXS" / "manifest.xml").write_text(MANIFEST, encoding="utf-8")
    (ext / "host").mkdir()
    (ext / "host" / "index.jsx").write_text("function gcutApply() {}\nfunction gcutToolGetSequence() {}", encoding="utf-8")
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


def test_the_host_is_listed_whole_and_mcp_never(repo):
    names = [arc for _, arc in pkg.files(include_backend=True)]
    assert "host/index.jsx" in names
    assert not any(n.startswith("mcp/") or "premiere-mcp" in n for n in names)


def test_the_zip_carries_the_toolbox_in_index_jsx_and_no_personal_door(repo):
    out = pkg.build("1.2.3", include_backend=False)
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert b"function gcutToolGetSequence" in z.read("host/index.jsx")
        assert not any(pkg.BRIDGE_MARKER in z.read(n) for n in names)
    assert "client/dist/index.html" in names
    assert not any("premiere-mcp" in n or n.startswith("mcp/") for n in names)


def test_main_without_check_packages_the_real_host_from_a_default_dist(repo, monkeypatch, capsys):
    """Plan task 3's check: the real host/index.jsx goes in whole, with the toolbox; no assistant.jsx, mcp/ or bridge marker."""
    shutil.copyfile(REAL_HOST, repo / "extension" / "host" / "index.jsx")
    monkeypatch.setattr(sys, "argv", ["package.py", "1.2.3"])
    pkg.main()
    assert "zip=dist/genius-cut-1.2.3.zip" in capsys.readouterr().out
    with zipfile.ZipFile(repo / "dist" / "genius-cut-1.2.3.zip") as z:
        names = z.namelist()
        host = z.read("host/index.jsx")
        assert host == REAL_HOST.read_bytes()
        for fn in (b"gcutToolGetSequence", b"gcutToolAddMarkers", b"gcutToolCutRanges", b"gcutToolUndo"):
            assert b"function " + fn + b"(" in host
        assert not any(pkg.BRIDGE_MARKER in z.read(n) for n in names)
    assert not any(n.endswith("assistant.jsx") for n in names)
    assert not any("premiere-mcp" in n or n.startswith("mcp/") for n in names)
