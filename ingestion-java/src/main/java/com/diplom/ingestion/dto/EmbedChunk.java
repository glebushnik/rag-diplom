package com.diplom.ingestion.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Map;
import java.util.UUID;

public record EmbedChunk(
        @JsonProperty("chunk_id") UUID chunkId,
        @JsonProperty("document_id") UUID documentId,
        int index,
        String text,
        String lang,
        @JsonProperty("token_count") int tokenCount,
        Map<String, Object> metadata
) {
}
