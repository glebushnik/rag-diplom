from app.main import BuildRequest, build_local_structure


def test_build_local_structure_with_context():
    payload = BuildRequest(
        source_id="source-1",
        user_id="user-1",
        title="Курс",
        goal="Освоить тему",
        level="beginner",
    )

    context = [
        {"chunk_id": "c1", "text": "Первый фрагмент текста для урока", "score": 0.9},
        {"chunk_id": "c2", "text": "Второй фрагмент текста для урока", "score": 0.8},
    ]

    structure = build_local_structure(payload, context)
    assert structure["title"] == "Курс"
    assert structure["modules"]
    assert structure["modules"][0]["lessons"]


def test_build_local_structure_without_context():
    payload = BuildRequest(
        source_id="source-2",
        user_id=None,
        title="Пустой курс",
        goal="Цель",
        level="beginner",
    )

    structure = build_local_structure(payload, [])
    assert len(structure["modules"]) == 1
    assert structure["modules"][0]["title"].startswith("Модуль 1")
