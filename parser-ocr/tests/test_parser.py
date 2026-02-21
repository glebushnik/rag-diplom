from fastapi.testclient import TestClient

from app.main import app, split_to_chunks


def test_split_to_chunks_returns_chunks_for_long_text():
    text = "слово " * 600
    chunks = split_to_chunks(text, max_chars=120, overlap=20)

    assert len(chunks) > 1
    assert all(chunk.strip() for chunk in chunks)


def test_parse_plain_text_file_success():
    client = TestClient(app)

    response = client.post(
        "/parse",
        files={"file": ("doc.txt", "Привет мир. Это тестовый документ.".encode("utf-8"), "text/plain")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["document_meta"]["filename"] == "doc.txt"
    assert payload["chunks"]
    assert payload["chunks"][0]["lang"] == "ru"
