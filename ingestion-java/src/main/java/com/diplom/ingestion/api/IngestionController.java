package com.diplom.ingestion.api;

import com.diplom.ingestion.dto.IngestResponse;
import com.diplom.ingestion.dto.JobStatusResponse;
import com.diplom.ingestion.exception.ApiErrorException;
import com.diplom.ingestion.service.IngestionService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;
import java.util.UUID;

@RestController
public class IngestionController {
    private final IngestionService ingestionService;

    @Value("${security.internal-token:}")
    private String expectedInternalToken;

    public IngestionController(IngestionService ingestionService) {
        this.ingestionService = ingestionService;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @PostMapping(value = "/ingest", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<IngestResponse> ingest(
            @RequestHeader(value = "X-Request-Id", required = false) String requestId,
            @RequestHeader(value = "X-Internal-Token", required = false) String internalToken,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "sourceId", required = false) String sourceId,
            @RequestParam(value = "documentId", required = false) String documentId,
            @RequestParam(value = "userId", required = false) String userId,
            @RequestParam(value = "sourceType", defaultValue = "document") String sourceType
    ) {
        verifyInternalToken(internalToken);
        String resolvedRequestId = normalizeRequestId(requestId);

        UUID sourceUuid = parseUuid(sourceId, "sourceId");
        UUID documentUuid = parseUuid(documentId, "documentId");
        UUID userUuid = parseUuid(userId, "userId");

        IngestResponse response = ingestionService.ingest(
                file,
                sourceUuid,
                documentUuid,
                userUuid,
                sourceType,
                resolvedRequestId
        );

        return ResponseEntity.ok().header("X-Request-Id", resolvedRequestId).body(response);
    }

    @GetMapping("/ingest/{jobId}")
    public ResponseEntity<JobStatusResponse> getStatus(
            @RequestHeader(value = "X-Request-Id", required = false) String requestId,
            @RequestHeader(value = "X-Internal-Token", required = false) String internalToken,
            @PathVariable("jobId") String jobId
    ) {
        verifyInternalToken(internalToken);
        String resolvedRequestId = normalizeRequestId(requestId);

        UUID jobUuid = parseUuid(jobId, "jobId");
        JobStatusResponse response = ingestionService.getJobStatus(jobUuid);
        return ResponseEntity.ok().header("X-Request-Id", resolvedRequestId).body(response);
    }

    private void verifyInternalToken(String providedToken) {
        if (expectedInternalToken == null || expectedInternalToken.isBlank()) {
            return;
        }

        if (providedToken == null || !expectedInternalToken.equals(providedToken)) {
            throw new ApiErrorException(
                    "UNAUTHORIZED_INTERNAL",
                    "Invalid internal token",
                    401,
                    Map.of()
            );
        }
    }

    private UUID parseUuid(String raw, String fieldName) {
        if (raw == null || raw.isBlank()) {
            return null;
        }

        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException exception) {
            throw new ApiErrorException(
                    "INVALID_UUID",
                    fieldName + " must be a valid UUID",
                    400,
                    Map.of("field", fieldName)
            );
        }
    }

    private String normalizeRequestId(String requestId) {
        if (requestId == null || requestId.isBlank()) {
            return UUID.randomUUID().toString();
        }
        return requestId;
    }
}
