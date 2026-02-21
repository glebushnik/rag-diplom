package com.diplom.ingestion.dto;

import java.util.UUID;

public record IngestResponse(
        UUID jobId,
        UUID sourceId,
        UUID documentId,
        String status
) {
}
