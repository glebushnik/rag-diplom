package com.diplom.ingestion.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.UUID;

public record EmbeddingVector(
        @JsonProperty("chunk_id") UUID chunkId,
        List<Float> vector,
        int dim
) {
}
