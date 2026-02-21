package com.diplom.ingestion.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Map;

public record ParseChunk(
        int index,
        String text,
        String lang,
        @JsonProperty("token_count") int tokenCount,
        Map<String, Object> metadata
) {
}
