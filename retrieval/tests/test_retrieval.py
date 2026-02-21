import importlib

from fastapi.testclient import TestClient


def load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("FAISS_DATA_DIR", str(tmp_path))
    module = importlib.import_module("app.main")
    module = importlib.reload(module)
    return module.app


def test_index_and_search_with_query_vector(monkeypatch, tmp_path):
    app = load_app(monkeypatch, tmp_path)
    client = TestClient(app)

    index_payload = {
        "source_id": "source-1",
        "embeddings": [
            {"chunk_id": "chunk-1", "vector": [1.0, 0.0], "dim": 2},
            {"chunk_id": "chunk-2", "vector": [0.0, 1.0], "dim": 2},
        ],
        "chunks": [
            {"chunk_id": "chunk-1", "document_id": "doc-1", "index": 0, "text": "alpha", "metadata": {"page": 1}},
            {"chunk_id": "chunk-2", "document_id": "doc-1", "index": 1, "text": "beta", "metadata": {"page": 2}},
        ],
    }

    index_response = client.post("/index", json=index_payload)
    assert index_response.status_code == 200
    assert index_response.json()["indexed"] == 2

    search_response = client.post(
        "/search",
        json={"source_id": "source-1", "query_vector": [1.0, 0.0], "top_k": 1},
    )
    assert search_response.status_code == 200
    results = search_response.json()["results"]
    assert len(results) == 1
    assert results[0]["chunk_id"] == "chunk-1"
