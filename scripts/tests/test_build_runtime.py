import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_runtime as br  # noqa: E402


def test_patch_pth_enables_site_packages_and_site_import():
    original = "python314.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n"
    out = br.patch_pth(original)
    lines = out.splitlines()
    assert "Lib\\site-packages" in lines
    assert "import site" in lines and "#import site" not in lines
    assert lines[0] == "python314.zip"


def test_patch_pth_is_idempotent():
    once = br.patch_pth("python314.zip\n.\n#import site\n")
    assert br.patch_pth(once) == once


def test_trim_removes_listed_files_anywhere_and_reports_bytes(tmp_path):
    a = tmp_path / "Lib/site-packages/nvidia/cudnn/bin"; a.mkdir(parents=True)
    (a / "cudnn_adv64_9.dll").write_bytes(b"x" * 10)
    (a / "cudnn64_9.dll").write_bytes(b"y" * 5)
    removed = br.trim(tmp_path, ["cudnn_adv64_9.dll", "not_there.dll"])
    assert removed == 10
    assert not (a / "cudnn_adv64_9.dll").exists() and (a / "cudnn64_9.dll").exists()


def test_trim_list_is_read_from_the_data_file():
    names = br.load_trim_list()
    assert "cudnn_engines_precompiled64_9.dll" in names and all(not n.startswith("#") for n in names)


def test_requirements_by_flavour():
    assert br.requirements_for("cuda").name == "requirements.txt"
    assert br.requirements_for("cpu").name == "requirements-runtime.txt"


def _fake_system32(tmp_path, skip=()):
    sys32 = tmp_path / "System32"; sys32.mkdir()
    for n in br.MSVC_RUNTIME_DLLS:
        if n not in skip:
            (sys32 / n).write_bytes(b"sys:" + n.encode())
    return sys32


def test_copy_msvc_runtime_copies_every_listed_dll_into_the_runtime_root(tmp_path):
    stage = tmp_path / "stage"; stage.mkdir()
    br.copy_msvc_runtime(stage, _fake_system32(tmp_path))
    for n in br.MSVC_RUNTIME_DLLS:
        assert (stage / n).read_bytes() == b"sys:" + n.encode()
    assert {"msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "concrt140.dll"} <= set(br.MSVC_RUNTIME_DLLS)


def test_copy_msvc_runtime_keeps_the_embeddables_own_vcruntime(tmp_path):
    stage = tmp_path / "stage"; stage.mkdir()
    (stage / "vcruntime140.dll").write_bytes(b"embeddable")
    (stage / "msvcp140.dll").write_bytes(b"stale")
    br.copy_msvc_runtime(stage, _fake_system32(tmp_path))
    assert (stage / "vcruntime140.dll").read_bytes() == b"embeddable"
    assert (stage / "msvcp140.dll").read_bytes() == b"sys:msvcp140.dll"


def test_copy_msvc_runtime_fails_when_an_msvcp_dll_is_missing_on_the_build_machine(tmp_path):
    import pytest
    stage = tmp_path / "stage"; stage.mkdir()
    with pytest.raises(SystemExit, match="msvcp140_1.dll"):
        br.copy_msvc_runtime(stage, _fake_system32(tmp_path, skip=("msvcp140_1.dll",)))
