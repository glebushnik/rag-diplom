from fastapi.testclient import TestClient

from app.main import app


def test_embed_local_provider(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "local")
    monkeypatch.setenv("EMBEDDING_DIM", "8")
    client = TestClient(app)

    payload = {
        "chunks": [
            {
                "chunk_id": "c1",
                "document_id": "d1",
                "index": 0,
                "text": "Пример текста",
                "lang": "ru",
                "token_count": 2,
                "metadata": {"page": 1},
            }
        ]
    }

    response = client.post("/embed", json=payload)
    assert response.status_code == 200

    data = response.json()
    assert data["provider"] == "local"
    assert len(data["embeddings"]) == 1
    assert data["embeddings"][0]["dim"] == 8
    assert len(data["embeddings"][0]["vector"]) == 8


def test_embed_invalid_provider(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "invalid")
    client = TestClient(app)

    payload = {
        "chunks": [
            {
                "chunk_id": "c1",
                "document_id": "d1",
                "index": 0,
                "text": "text",
                "lang": "ru",
                "token_count": 1,
                "metadata": {},
            }
        ]
    }

    response = client.post("/embed", json=payload)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_PROVIDER"
