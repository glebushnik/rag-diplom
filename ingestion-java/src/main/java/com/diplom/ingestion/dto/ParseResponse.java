package com.diplom.ingestion.dto;

import java.util.List;
import java.util.Map;

public record ParseResponse(
        Map<String, Object> document_meta,
        List<ParseChunk> chunks
) {
}
