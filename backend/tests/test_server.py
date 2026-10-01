from fastapi.testclient import TestClient

from geniuscut.config import get_or_create_token
from server import create_app


def client(tmp_path, stt_device="cuda"):
    token = get_or_create_token(tmp_path)
    return TestClient(create_app(token=token, stt_device=lambda: stt_device), base_url="http://127.0.0.1:8791"), token


def test_health_needs_no_token_and_reports_device(tmp_path):
    c, _ = client(tmp_path, stt_device="cpu")
    r = c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["stt_device"] == "cpu"
    assert body["version"]


def test_protected_route_rejects_missing_and_wrong_token(tmp_path):
    c, _ = client(tmp_path)
    assert c.get("/library").status_code == 401
    assert c.get("/library", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_protected_route_accepts_the_right_token(tmp_path):
    c, token = client(tmp_path)
    assert c.get("/library", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_token_is_created_once_and_reused(tmp_path):
    first = get_or_create_token(tmp_path)
    assert len(first) >= 32
    assert get_or_create_token(tmp_path) == first
    assert (tmp_path / "token").read_text(encoding="utf-8").strip() == first


def test_server_imports_geniuscut_even_when_its_folder_is_not_on_sys_path():
    # Review Focus 5: embeddable Python's ._pth stops the script's folder being added.
    import subprocess, sys
    from pathlib import Path
    server = Path(__file__).resolve().parents[1] / "server.py"
    code = ("import os, sys, runpy; "
            f"bd = os.path.normcase(r'{server.parent}'); "
            "sys.path = [p for p in sys.path if os.path.normcase(os.path.abspath(p or os.getcwd())) != bd]; "
            f"runpy.run_path(r'{server}', run_name='not_main'); print('ok')")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(server.parents[1]))
    assert r.stdout.strip().endswith("ok"), r.stderr
