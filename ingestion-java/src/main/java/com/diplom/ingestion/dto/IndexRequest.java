package com.diplom.ingestion.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.UUID;

public record IndexRequest(
        @JsonProperty("source_id") UUID sourceId,
        List<EmbeddingVector> embeddings,
        List<IndexChunk> chunks
) {
}
