package com.diplom.ingestion.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

public record EmbedRequest(
        @JsonProperty("provider_override") String providerOverride,
        List<EmbedChunk> chunks
) {
}
