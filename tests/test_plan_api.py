"""План изменений на сервере: GET/PUT /plan."""
import pytest
from fastapi.testclient import TestClient

from twin_bishkek import api

JK = dict(id="p1", kind="build", where="jal", start="2027-01", end="2028-03", type="jk", cap=1400, spots=700, floors=16,
          title="ЖК «Джал-Парк»", note="")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TB_PLAN_FILE", str(tmp_path / "plan.json"))
    monkeypatch.setenv("TB_COLLECT", "0")
    with TestClient(api.app) as c:
        yield c


def test_plan_is_empty_before_first_save(client):
    assert client.get("/plan").json() == {"items": [], "updated": None}


def test_plan_round_trip(client):
    r = client.put("/plan", json={"items": [JK, dict(id="p2", kind="bridge", where="b1", start="2027-02", end="2027-06")]})
    assert r.status_code == 200 and r.json()["saved"] == 2
    got = client.get("/plan").json()
    assert got["updated"] and [i["id"] for i in got["items"]] == ["p1", "p2"]
    assert got["items"][0]["title"] == "ЖК «Джал-Парк»" and got["items"][1]["cap"] is None


def test_plan_keeps_new_road(client):
    road = dict(id="r1", kind="road", where="", start="2027-01", end="2030-01", rkind="tunnel", lanes=4,
                pts=[[300, 470], [540, 470]], route="от Запада до центра")
    assert client.put("/plan", json={"items": [road]}).status_code == 200
    got = client.get("/plan").json()["items"][0]
    assert got["rkind"] == "tunnel" and got["pts"] == [[300, 470], [540, 470]] and got["route"] == "от Запада до центра"
    assert client.put("/plan", json={"items": [road | dict(rkind="metro")]}).status_code == 422


def test_simulate_accepts_roads(client):
    body = dict(roads=[dict(kind="elevated", lanes=4, pts=[[300, 470], [540, 470], [820, 490]])])
    r = client.post("/simulate", json=body).json()
    assert r["roads"][0]["kind"] == "elevated" and r["params"]["roads"][0]["pts"][0] == [300, 470]
    assert client.post("/simulate", json=dict(roads=[dict(kind="metro", pts=[[0, 0], [9, 9]])])).status_code == 422


def test_plan_can_be_cleared(client):
    client.put("/plan", json={"items": [JK]})
    client.put("/plan", json={"items": []})
    got = client.get("/plan").json()
    assert got["items"] == [] and got["updated"]  # очищенный план — это сохранённый пустой план, а не «ещё не сохраняли»


@pytest.mark.parametrize("bad", [dict(kind="demolish"), dict(start="2027-1"), dict(cap=-5), dict(title="x" * 500)])
def test_plan_rejects_garbage(client, bad):
    assert client.put("/plan", json={"items": [JK | bad]}).status_code == 422
    assert client.get("/plan").json()["items"] == []
