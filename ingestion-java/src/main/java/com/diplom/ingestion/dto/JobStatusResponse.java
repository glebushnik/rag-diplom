package com.diplom.ingestion.dto;

import java.util.UUID;

public record JobStatusResponse(
        UUID jobId,
        UUID sourceId,
        String status,
        String error
) {
}
