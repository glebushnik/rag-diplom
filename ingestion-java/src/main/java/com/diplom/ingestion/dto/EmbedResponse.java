package com.diplom.ingestion.dto;

import java.util.List;

public record EmbedResponse(
        String provider,
        List<EmbeddingVector> embeddings
) {
}
