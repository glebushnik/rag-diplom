from fastapi.testclient import TestClient

from app.main import app, create_access_token


def test_health_endpoint():
    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_create_access_token(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    token = create_access_token("user-id", "user@example.com")

    assert isinstance(token, str)
    assert token.count(".") == 2
